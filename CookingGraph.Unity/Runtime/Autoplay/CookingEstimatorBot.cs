using System;
using System.Collections.Generic;
using System.Linq;

namespace CookingGraph
{
    /// <summary>
    /// Continuously replans against live game state and submits at most one logical pick per Tick.
    /// Call Tick from Update (or a gameplay scheduler); it never blocks or awaits a coroutine.
    /// </summary>
    public sealed class CookingEstimatorBot
    {
        private sealed class PendingPick
        {
            public long acceptedRevision;
            public readonly List<string> itemIds = new List<string>();
            public readonly List<BotCommittedIngredientState> ingredients = new List<BotCommittedIngredientState>();
        }

        private readonly ICookingBotStateReader _stateReader;
        private readonly ICookingBotCommandSink _commandSink;
        private readonly EstimatorBotSettings _settings;
        private readonly List<PendingPick> _pending = new List<PendingPick>();
        private EstimatorBotScorer _scorer;
        private Random _random;
        private long _nextCommandId = 1;
        private float _peakGridRatio;
        private float _peakDirtyRatio;
        private int _acceptedPickCount;
        private int _randomPickCount;
        private float _peakConcurrentWorkRatio;
        private float _nextPickAtSeconds = float.NegativeInfinity;
        private float _lastAcceptedPickAtSeconds = float.NegativeInfinity;
        private readonly HashSet<int> _timedOutCustomerIndices = new HashSet<int>();
        private ICookingBotVerboseLogListener _verboseLogListener;

        public CookingGraphAsset Graph { get; private set; }
        public BotDecision LastDecision { get; private set; }
        public int PendingPickCount => _pending.Count;
        public bool IsInitialized => _scorer != null;
        public CookingBotPickingStrategy PickingStrategy { get; private set; } = CookingBotPickingStrategy.Balanced;
        public float Intelligent { get; private set; }
        public float PickIntervalSeconds => EffectiveSettings().pickIntervalSeconds;
        public CookingBotWorkWaitStrategy WorkWaitStrategy => _settings.workWaitStrategy;
        public CookingBotWorkWaitStrategy EffectiveWorkWaitStrategy => ResolveWorkWaitStrategy();
        public float NextPickAtSeconds => _nextPickAtSeconds;
        public bool IsWaitingForGridCapacity => LastDecision != null && LastDecision.deferredByGridPressure;
        public bool IsWaitingForWorkCompletion { get; private set; }
        public IReadOnlyList<int> TimedOutCustomerIndices => _timedOutCustomerIndices.OrderBy(value => value).ToList();
        public CookingBotFailureKnowledge FailureKnowledge { get; private set; }
        public bool VerboseLoggingEnabled { get; private set; }

        public CookingEstimatorBot(
            ICookingBotStateReader stateReader,
            ICookingBotCommandSink commandSink,
            EstimatorBotSettings settings = null,
            ICookingBotVerboseLogListener verboseLogListener = null)
        {
            _stateReader = stateReader ?? throw new ArgumentNullException(nameof(stateReader));
            _commandSink = commandSink ?? throw new ArgumentNullException(nameof(commandSink));
            _settings = settings ?? new EstimatorBotSettings();
            _verboseLogListener = verboseLogListener;
            Intelligent = ClampIntelligent(_settings.intelligent);
        }

        /// <summary>Initializes or reinitializes the bot for one map graph.</summary>
        public void Init(CookingGraphAsset mapGraph)
        {
            Init(mapGraph, null);
        }

        /// <summary>
        /// Initializes the bot with optional aggregate lessons from an earlier failed run. Passing
        /// null starts with empty knowledge; the supplied object is retained and updated in place.
        /// </summary>
        public void Init(CookingGraphAsset mapGraph, CookingBotFailureKnowledge failureKnowledge)
        {
            Graph = mapGraph != null ? mapGraph : throw new ArgumentNullException(nameof(mapGraph));
            FailureKnowledge = failureKnowledge ?? new CookingBotFailureKnowledge();
            _scorer = new EstimatorBotScorer(mapGraph, EffectiveSettings());
            _random = new Random(_settings.randomSeed);
            _pending.Clear();
            LastDecision = null;
            _nextCommandId = 1;
            _peakGridRatio = 0;
            _peakDirtyRatio = 0;
            _acceptedPickCount = 0;
            _randomPickCount = 0;
            _peakConcurrentWorkRatio = 0;
            _nextPickAtSeconds = float.NegativeInfinity;
            _lastAcceptedPickAtSeconds = float.NegativeInfinity;
            _timedOutCustomerIndices.Clear();
            IsWaitingForWorkCompletion = false;
            Verbose(
                CookingBotVerboseLogKind.Initialized,
                "Bot initialized for a new run.");
        }

        /// <summary>
        /// Enables or disables verbose records immediately. Supplying a listener also replaces the
        /// current listener; omit it to preserve the listener already registered on the bot.
        /// </summary>
        public void SetVerboseLogging(bool enabled, ICookingBotVerboseLogListener listener = null)
        {
            if (listener != null) _verboseLogListener = listener;
            VerboseLoggingEnabled = enabled;
            if (enabled)
                Verbose(CookingBotVerboseLogKind.ConfigurationChanged, "Verbose logging enabled.");
        }

        /// <summary>Replaces or clears the listener without changing whether logging is enabled.</summary>
        public void SetVerboseLogListener(ICookingBotVerboseLogListener listener)
        {
            _verboseLogListener = listener;
        }

        /// <summary>
        /// Changes the scoring profile for the next Tick. Graph caches, RNG progress, and pending
        /// accepted-pick reservations are preserved.
        /// </summary>
        public void SetPickingStrategy(CookingBotPickingStrategy strategy)
        {
            if (!Enum.IsDefined(typeof(CookingBotPickingStrategy), strategy))
                throw new ArgumentOutOfRangeException(nameof(strategy), strategy, null);
            PickingStrategy = strategy;
            _scorer?.SetSettings(EffectiveSettings());
            Verbose(CookingBotVerboseLogKind.ConfigurationChanged, "Picking strategy changed.");
        }

        /// <summary>
        /// Changes strategy accuracy for the next Tick. Zero picks randomly among legal options;
        /// one always uses the configured strategy. Values outside the range are clamped.
        /// </summary>
        public void SetIntelligent(float intelligent)
        {
            Intelligent = ClampIntelligent(intelligent);
            Verbose(CookingBotVerboseLogKind.ConfigurationChanged, "Intelligence changed.");
        }

        /// <summary>
        /// Changes the base pick cadence for the next Tick. Prior failure knowledge may increase
        /// this value. An already-running cooldown is recalculated from the last accepted pick.
        /// </summary>
        public void SetPickIntervalSeconds(float seconds)
        {
            if (float.IsNaN(seconds) || float.IsInfinity(seconds))
                throw new ArgumentOutOfRangeException(nameof(seconds), seconds, "Pick interval must be finite.");
            _settings.pickIntervalSeconds = Math.Max(0, seconds);
            if (!float.IsNegativeInfinity(_lastAcceptedPickAtSeconds))
                _nextPickAtSeconds = _lastAcceptedPickAtSeconds + PickIntervalSeconds;
            Verbose(CookingBotVerboseLogKind.ConfigurationChanged, "Pick interval changed.");
        }

        /// <summary>
        /// Changes tool/merge synchronization for the next Tick without resetting cadence,
        /// reservations, graph caches, or learned failure knowledge.
        /// </summary>
        public void SetWorkWaitStrategy(CookingBotWorkWaitStrategy strategy)
        {
            if (!Enum.IsDefined(typeof(CookingBotWorkWaitStrategy), strategy))
                throw new ArgumentOutOfRangeException(nameof(strategy), strategy, null);
            _settings.workWaitStrategy = strategy;
            Verbose(CookingBotVerboseLogKind.ConfigurationChanged, "Work wait strategy changed.");
        }

        /// <summary>
        /// Reads, replans and attempts one pick. True means the game accepted the logical command.
        /// A false result is normal while nothing is pickupable or when a snapshot became stale.
        /// </summary>
        public bool Tick()
        {
            if (_scorer == null) throw new InvalidOperationException("Call Init(mapGraph) before Tick().");
            var state = _stateReader.ReadState();
            if (state == null)
            {
                LastDecision = null;
                Verbose(CookingBotVerboseLogKind.StateUnavailable, "State reader returned no snapshot.");
                return false;
            }

            ObserveRunState(state);
            IsWaitingForWorkCompletion = false;
            if (!state.isPlaying)
            {
                LastDecision = null;
                Verbose(CookingBotVerboseLogKind.NotPlaying, "Snapshot reports that gameplay is not running.", state);
                return false;
            }

            if (float.IsNaN(state.gameplayTimeSeconds) || float.IsInfinity(state.gameplayTimeSeconds))
                throw new InvalidOperationException("BotGameState.gameplayTimeSeconds must be finite.");

            ReconcilePending(state);
            if (state.gameplayTimeSeconds + 0.0001f < _nextPickAtSeconds)
            {
                LastDecision = null;
                Verbose(CookingBotVerboseLogKind.Cooldown, "Waiting for the next pick deadline.", state);
                return false;
            }
            if (ShouldWaitForWorkCompletion(state))
            {
                LastDecision = null;
                IsWaitingForWorkCompletion = true;
                Verbose(
                    CookingBotVerboseLogKind.WaitingForWorkCompletion,
                    "Pick interval elapsed; waiting for active tool and merge work to settle.",
                    state);
                return false;
            }
            var reserved = new HashSet<string>(_pending.SelectMany(value => value.itemIds), StringComparer.Ordinal);
            var optimistic = _pending.SelectMany(value => value.ingredients).ToList();
            var decision = _scorer.Decide(state, reserved, optimistic, _random, Intelligent);
            LastDecision = decision;
            if (decision?.option == null)
            {
                Verbose(CookingBotVerboseLogKind.NoLegalPick, "No legal pickup option was selected.", state);
                return false;
            }
            decision.pickingStrategy = PickingStrategy;
            decision.workWaitStrategy = EffectiveWorkWaitStrategy;
            decision.intelligent = Intelligent;
            var pickIntervalSeconds = PickIntervalSeconds;
            decision.pickIntervalSeconds = pickIntervalSeconds;
            Verbose(CookingBotVerboseLogKind.DecisionSelected, "Pickup option selected.", state, decision);
            if (ShouldDeferForGridCapacity(state, decision, optimistic))
            {
                Verbose(CookingBotVerboseLogKind.GridCapacityDeferred, "Pickup deferred by projected grid pressure.", state, decision);
                return false;
            }

            var command = new BotPickCommand
            {
                commandId = _nextCommandId++,
                observedRevision = state.revision,
                queueIndex = decision.option.queueIndex,
                expectedItemId = decision.option.itemId,
                score = decision.score,
                randomFallback = decision.randomFallback,
                pickingStrategy = PickingStrategy,
                workWaitStrategy = EffectiveWorkWaitStrategy,
                intelligent = Intelligent,
                pickIntervalSeconds = pickIntervalSeconds
            };
            if (!_commandSink.TryPick(command))
            {
                Verbose(CookingBotVerboseLogKind.CommandRejected, "Game rejected the pick command; the bot will replan.", state, decision, command);
                return false;
            }

            _acceptedPickCount++;
            if (decision.randomFallback) _randomPickCount++;
            _lastAcceptedPickAtSeconds = state.gameplayTimeSeconds;
            _nextPickAtSeconds = state.gameplayTimeSeconds + pickIntervalSeconds;

            var pending = new PendingPick { acceptedRevision = state.revision };
            if (decision.option.consumedItemIds != null && decision.option.consumedItemIds.Count > 0)
                pending.itemIds.AddRange(decision.option.consumedItemIds.Where(value => !string.IsNullOrEmpty(value)));
            else if (!string.IsNullOrEmpty(decision.option.itemId))
                pending.itemIds.Add(decision.option.itemId);
            var pickedIngredients = decision.option.ingredients != null && decision.option.ingredients.Count > 0
                ? decision.option.ingredients
                : IngredientFromVisibleQueue(state, decision.option);
            foreach (var ingredient in pickedIngredients)
                if (ingredient != null)
                    pending.ingredients.Add(new BotCommittedIngredientState
                    {
                        ingredient = ingredient,
                        amount = 1,
                        sourceItemId = decision.option.itemId
                    });
            _pending.Add(pending);
            Verbose(CookingBotVerboseLogKind.PickAccepted, "Game accepted the logical pick.", state, decision, command);
            return true;
        }

        /// <summary>
        /// Accumulates the completed run into the serializable knowledge supplied to Init and
        /// returns that same object for persistence or use by the next bot instance.
        /// </summary>
        public CookingBotFailureKnowledge AccumulateFailure(CookingBotFailureReport failure)
        {
            if (_scorer == null) throw new InvalidOperationException("Call Init(mapGraph) before accumulating a failure.");
            if (failure == null) throw new ArgumentNullException(nameof(failure));
            var randomRatio = _acceptedPickCount > 0 ? (float)_randomPickCount / _acceptedPickCount : 0;
            FailureKnowledge.Accumulate(
                failure,
                _peakGridRatio,
                _peakDirtyRatio,
                randomRatio,
                _peakConcurrentWorkRatio);
            _scorer.SetSettings(EffectiveSettings());
            Verbose(CookingBotVerboseLogKind.FailureKnowledgeAccumulated, "Failed-run knowledge accumulated for a later attempt.");
            return FailureKnowledge;
        }

        private static List<IngredientNodeAsset> IngredientFromVisibleQueue(BotGameState state, BotPickupOption option)
        {
            if (option.queueIndex < 0 || option.queueIndex >= (state.visibleQueues?.Count ?? 0)) return new List<IngredientNodeAsset>();
            var lane = state.visibleQueues[option.queueIndex];
            var item = lane?.items?.FirstOrDefault(value => value != null && value.itemId == option.itemId);
            return item?.ingredient != null ? new List<IngredientNodeAsset> { item.ingredient } : new List<IngredientNodeAsset>();
        }

        private void ReconcilePending(BotGameState state)
        {
            if (_pending.Count == 0) return;
            var countBefore = _pending.Count;
            var pickupable = new HashSet<string>(
                (state.pickupables ?? new List<BotPickupOption>())
                    .Where(value => value != null)
                    .SelectMany(PickupIds)
                    .Where(value => !string.IsNullOrEmpty(value)),
                StringComparer.Ordinal);
            _pending.RemoveAll(value =>
                state.revision > value.acceptedRevision &&
                value.itemIds.All(itemId => !pickupable.Contains(itemId)));
            if (_pending.Count != countBefore)
                Verbose(CookingBotVerboseLogKind.PendingReconciled, "Accepted-pick reservations reconciled with live state.", state);
        }

        private void Verbose(
            CookingBotVerboseLogKind kind,
            string message,
            BotGameState state = null,
            BotDecision decision = null,
            BotPickCommand command = null)
        {
            if (!VerboseLoggingEnabled || _verboseLogListener == null) return;
            var includesProjection = decision != null &&
                (kind == CookingBotVerboseLogKind.GridCapacityDeferred ||
                 kind == CookingBotVerboseLogKind.CommandRejected ||
                 kind == CookingBotVerboseLogKind.PickAccepted);
            _verboseLogListener.OnCookingBotVerboseLog(new CookingBotVerboseLog
            {
                kind = kind,
                message = message,
                revision = state?.revision ?? -1,
                gameplayTimeSeconds = state?.gameplayTimeSeconds ?? -1,
                commandId = command?.commandId ?? -1,
                queueIndex = decision?.option?.queueIndex ?? command?.queueIndex ?? -1,
                itemId = decision?.option?.itemId ?? command?.expectedItemId,
                score = decision?.score ?? command?.score ?? -1,
                randomFallback = decision?.randomFallback ?? command?.randomFallback ?? false,
                pendingPickCount = _pending.Count,
                nextPickAtSeconds = float.IsNegativeInfinity(_nextPickAtSeconds) ? -1 : _nextPickAtSeconds,
                projectedGridLoad = includesProjection ? decision.projectedGridLoad : -1,
                usableGridCapacity = includesProjection ? decision.usableGridCapacity : -1,
                pickingStrategy = PickingStrategy,
                workWaitStrategy = WorkWaitStrategy,
                effectiveWorkWaitStrategy = EffectiveWorkWaitStrategy,
                intelligent = Intelligent,
                pickIntervalSeconds = PickIntervalSeconds,
                activeToolProcessCount = state != null ? Math.Max(0, state.activeToolProcessCount) : -1,
                activeMergeAnimationCount = state != null ? Math.Max(0, state.activeMergeAnimationCount) : -1
            });
        }

        private static IEnumerable<string> PickupIds(BotPickupOption option)
        {
            return option.consumedItemIds != null && option.consumedItemIds.Count > 0
                ? (IEnumerable<string>)option.consumedItemIds
                : new[] { option.itemId };
        }

        private EstimatorBotSettings EffectiveSettings()
        {
            var settings = _settings.ForStrategy(PickingStrategy);
            FailureKnowledge?.ApplyTo(settings);
            return settings;
        }

        private CookingBotWorkWaitStrategy ResolveWorkWaitStrategy()
        {
            if (_settings.workWaitStrategy != CookingBotWorkWaitStrategy.Adaptive)
                return _settings.workWaitStrategy;
            return (FailureKnowledge?.failureCount ?? 0) > 0
                ? CookingBotWorkWaitStrategy.WaitForToolAndMerge
                : CookingBotWorkWaitStrategy.IntervalOnly;
        }

        private bool ShouldWaitForWorkCompletion(BotGameState state)
        {
            if (ResolveWorkWaitStrategy() != CookingBotWorkWaitStrategy.WaitForToolAndMerge)
                return false;
            return Math.Max(0, state.activeToolProcessCount) > 0 ||
                   Math.Max(0, state.activeMergeAnimationCount) > 0;
        }

        /// <summary>
        /// Keep accepting overlapping picks while every committed output still fits. If the next
        /// candidate would exceed safe grid capacity, wait for live state to report that some
        /// cooking/transfer work drained, then replan on a later Tick.
        /// </summary>
        private bool ShouldDeferForGridCapacity(
            BotGameState state,
            BotDecision decision,
            IReadOnlyCollection<BotCommittedIngredientState> optimisticPending)
        {
            var cells = state.grid?.cells ?? new List<BotGridCellState>();
            var usableCapacity = cells.Count(cell =>
                cell != null && (cell.canHoldItem || cell.kind != BotGridItemKind.Empty));
            var occupied = cells.Count(cell => cell != null && cell.kind != BotGridItemKind.Empty);
            var committedByState = _scorer.EstimateCommittedFootprint(state.committedIngredients);
            var committedByPending = _scorer.EstimateCommittedFootprint(optimisticPending);
            var committed = Math.Max(committedByState, committedByPending);
            var projectedPipeline = _scorer.EstimateProjectedFootprint(
                state.committedIngredients,
                optimisticPending,
                decision.option,
                state);
            var settings = EffectiveSettings();
            var learnedReserve = (int)Math.Ceiling(Math.Max(0, settings.gridTightThreshold - 0.5f) * 10);
            learnedReserve = Math.Min(Math.Max(0, usableCapacity - 1), learnedReserve);
            var safeCapacity = Math.Max(1, usableCapacity - learnedReserve);

            decision.projectedGridLoad = occupied + projectedPipeline;
            decision.usableGridCapacity = usableCapacity;
            decision.deferredByGridPressure =
                !decision.option.picksSweeper &&
                usableCapacity > 0 &&
                committed > 0 &&
                decision.projectedGridLoad > safeCapacity;
            return decision.deferredByGridPressure;
        }

        private void ObserveRunState(BotGameState state)
        {
            foreach (var customerIndex in state.timedOutCustomerIndices ?? new List<int>())
                _timedOutCustomerIndices.Add(customerIndex);
            var cells = state.grid?.cells;
            if (cells == null || cells.Count == 0) return;
            var occupied = cells.Count(cell => cell != null && cell.kind != BotGridItemKind.Empty);
            var dirty = cells.Count(cell => cell != null && cell.kind == BotGridItemKind.Dirty);
            _peakGridRatio = Math.Max(_peakGridRatio, (float)occupied / cells.Count);
            _peakDirtyRatio = Math.Max(_peakDirtyRatio, (float)dirty / cells.Count);
            var committed = _scorer.EstimateCommittedFootprint(state.committedIngredients);
            var optimistic = _scorer.EstimateCommittedFootprint(_pending.SelectMany(value => value.ingredients));
            _peakConcurrentWorkRatio = Math.Max(
                _peakConcurrentWorkRatio,
                (float)Math.Max(committed, optimistic) / cells.Count);
        }

        private static float ClampIntelligent(float value)
        {
            if (float.IsNaN(value)) throw new ArgumentOutOfRangeException(nameof(value), value, "Intelligent cannot be NaN.");
            return Math.Max(0f, Math.Min(1f, value));
        }
    }
}
