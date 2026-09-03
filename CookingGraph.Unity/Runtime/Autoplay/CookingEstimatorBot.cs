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

        public CookingGraphAsset Graph { get; private set; }
        public BotDecision LastDecision { get; private set; }
        public int PendingPickCount => _pending.Count;
        public bool IsInitialized => _scorer != null;

        public CookingEstimatorBot(
            ICookingBotStateReader stateReader,
            ICookingBotCommandSink commandSink,
            EstimatorBotSettings settings = null)
        {
            _stateReader = stateReader ?? throw new ArgumentNullException(nameof(stateReader));
            _commandSink = commandSink ?? throw new ArgumentNullException(nameof(commandSink));
            _settings = settings ?? new EstimatorBotSettings();
        }

        /// <summary>Initializes or reinitializes the bot for one map graph.</summary>
        public void Init(CookingGraphAsset mapGraph)
        {
            Graph = mapGraph != null ? mapGraph : throw new ArgumentNullException(nameof(mapGraph));
            _scorer = new EstimatorBotScorer(mapGraph, _settings);
            _random = new Random(_settings.randomSeed);
            _pending.Clear();
            LastDecision = null;
            _nextCommandId = 1;
        }

        /// <summary>
        /// Reads, replans and attempts one pick. True means the game accepted the logical command.
        /// A false result is normal while nothing is pickupable or when a snapshot became stale.
        /// </summary>
        public bool Tick()
        {
            if (_scorer == null) throw new InvalidOperationException("Call Init(mapGraph) before Tick().");
            var state = _stateReader.ReadState();
            if (state == null || !state.isPlaying)
            {
                LastDecision = null;
                return false;
            }

            ReconcilePending(state);
            var reserved = new HashSet<string>(_pending.SelectMany(value => value.itemIds), StringComparer.Ordinal);
            var optimistic = _pending.SelectMany(value => value.ingredients).ToList();
            var decision = _scorer.Decide(state, reserved, optimistic, _random);
            LastDecision = decision;
            if (decision?.option == null) return false;

            var command = new BotPickCommand
            {
                commandId = _nextCommandId++,
                observedRevision = state.revision,
                queueIndex = decision.option.queueIndex,
                expectedItemId = decision.option.itemId,
                score = decision.score,
                randomFallback = decision.randomFallback
            };
            if (!_commandSink.TryPick(command)) return false;

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
    }
}
