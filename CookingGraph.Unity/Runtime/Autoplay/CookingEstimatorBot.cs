using System;
using System.Collections.Generic;
using System.Linq;

namespace CookingGraph
{
    /// <summary>
    /// Continuously replans against live game state and submits at most one logical pick per Tick.
    /// Call Tick from Update (or a gameplay scheduler); it never waits for an animation or coroutine.
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

        public CookingGraphAsset Graph { get; private set; }
        public BotDecision LastDecision { get; private set; }
        public int PendingPickCount => _pending.Count;
        public bool IsInitialized => _scorer != null;
        public CookingBotPickingStrategy PickingStrategy { get; private set; } = CookingBotPickingStrategy.Balanced;
        public float Intelligent { get; private set; }
        public float PickIntervalSeconds => EffectiveSettings().pickIntervalSeconds;
        public float NextPickAtSeconds => _nextPickAtSeconds;
        public bool IsWaitingForGridCapacity => LastDecision != null && LastDecision.deferredByGridPressure;
        public IReadOnlyList<int> TimedOutCustomerIndices => _timedOutCustomerIndices.OrderBy(value => value).ToList();
        public CookingBotFailureKnowledge FailureKnowledge { get; private set; }

        public CookingEstimatorBot(
            ICookingBotStateReader stateReader,
            ICookingBotCommandSink commandSink,
            EstimatorBotSettings settings = null)
        {
            _stateReader = stateReader ?? throw new ArgumentNullException(nameof(stateReader));
            _commandSink = commandSink ?? throw new ArgumentNullException(nameof(commandSink));
            _settings = settings ?? new EstimatorBotSettings();
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
        }

        /// <summary>
        /// Changes strategy accuracy for the next Tick. Zero picks randomly among legal options;
        /// one always uses the configured strategy. Values outside the range are clamped.
        /// </summary>
        public void SetIntelligent(float intelligent)
        {
            Intelligent = ClampIntelligent(intelligent);
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
                return false;
            }

            ObserveRunState(state);
            if (!state.isPlaying)
            {
                LastDecision = null;
                return false;
            }

            if (float.IsNaN(state.gameplayTimeSeconds) || float.IsInfinity(state.gameplayTimeSeconds))
                throw new InvalidOperationException("BotGameState.gameplayTimeSeconds must be finite.");

            ReconcilePending(state);
            if (state.gameplayTimeSeconds + 0.0001f < _nextPickAtSeconds)
            {
                LastDecision = null;
                return false;
            }
            var reserved = new HashSet<string>(_pending.SelectMany(value => value.itemIds), StringComparer.Ordinal);
            var optimistic = _pending.SelectMany(value => value.ingredients).ToList();
            var decision = _scorer.Decide(state, reserved, optimistic, _random, Intelligent);
            LastDecision = decision;
            if (decision?.option == null) return false;
            decision.pickingStrategy = PickingStrategy;
            decision.intelligent = Intelligent;
            var pickIntervalSeconds = PickIntervalSeconds;
            decision.pickIntervalSeconds = pickIntervalSeconds;
            if (ShouldDeferForGridCapacity(state, decision, optimistic)) return false;

            var command = new BotPickCommand
            {
                commandId = _nextCommandId++,
                observedRevision = state.revision,
                queueIndex = decision.option.queueIndex,
                expectedItemId = decision.option.itemId,
                score = decision.score,
                randomFallback = decision.randomFallback,
                pickingStrategy = PickingStrategy,
                intelligent = Intelligent,
                pickIntervalSeconds = pickIntervalSeconds
            };
            if (!_commandSink.TryPick(command)) return false;

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
            var pickupable = new HashSet<string>(
                (state.pickupables ?? new List<BotPickupOption>())
                    .Where(value => value != null)
                    .SelectMany(PickupIds)
                    .Where(value => !string.IsNullOrEmpty(value)),
                StringComparer.Ordinal);
            _pending.RemoveAll(value =>
                state.revision > value.acceptedRevision &&
                value.itemIds.All(itemId => !pickupable.Contains(itemId)));
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
            var committedByState = (state.committedIngredients ?? new List<BotCommittedIngredientState>())
                .Where(value => value != null)
                .Sum(value => Math.Max(0, value.amount));
            var committedByPending = (optimisticPending ?? Array.Empty<BotCommittedIngredientState>())
                .Where(value => value != null)
                .Sum(value => Math.Max(0, value.amount));
            var committed = (int)Math.Ceiling(Math.Max(committedByState, committedByPending));
            var footprint = Math.Max(0, _scorer.EstimateFootprint(decision.option, state));
            var settings = EffectiveSettings();
            var learnedReserve = (int)Math.Ceiling(Math.Max(0, settings.gridTightThreshold - 0.5f) * 10);
            learnedReserve = Math.Min(Math.Max(0, usableCapacity - 1), learnedReserve);
            var safeCapacity = Math.Max(1, usableCapacity - learnedReserve);

            decision.projectedGridLoad = occupied + committed + footprint;
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
            var committed = (state.committedIngredients ?? new List<BotCommittedIngredientState>())
                .Where(value => value != null)
                .Sum(value => Math.Max(0, value.amount));
            var optimistic = _pending.Sum(value => value.ingredients.Sum(ingredient => Math.Max(0, ingredient.amount)));
            _peakConcurrentWorkRatio = Math.Max(
                _peakConcurrentWorkRatio,
                Math.Max(committed, optimistic) / cells.Count);
        }

        private static float ClampIntelligent(float value)
        {
            if (float.IsNaN(value)) throw new ArgumentOutOfRangeException(nameof(value), value, "Intelligent cannot be NaN.");
            return Math.Max(0f, Math.Min(1f, value));
        }
    }
}
