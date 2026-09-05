using System;
using System.Collections.Generic;
using System.Linq;

namespace CookingGraph
{
    /// <summary>
    /// Online form of src/ui/design/nodeEstimateDifficulty.ts. It uses the same demand, recipe,
    /// preview, scarcity, look-ahead and grid-pressure terms, but scores the real game's current
    /// snapshot instead of advancing a private simulation to rest between picks.
    /// </summary>
    internal sealed class EstimatorBotScorer
    {
        private sealed class ProcessStep
        {
            public IngredientNodeAsset output;
            public readonly List<IngredientNodeAsset> inputs = new List<IngredientNodeAsset>();
            public int amount = 1;
        }

        private sealed class PreviewSlot
        {
            public bool isBase;
            public bool required;
            public readonly List<IngredientNodeAsset> options = new List<IngredientNodeAsset>();
        }

        private sealed class DemandUnit
        {
            public IngredientNodeAsset target;
            public int customerIndex;
            public float priority;
            public bool multiInput;
            public bool ready;
            public Dictionary<IngredientNodeAsset, float> requirements;
        }

        private sealed class DemandClaim
        {
            public float units;
            public float priority;
            public int customerIndex;
            public bool ready;
        }

        private struct PickupValue
        {
            public float score;
            public int customerIndex;
            public bool ready;
        }

        private struct CandidateValue
        {
            public float score;
            public int customerIndex;
            public bool fromFront;
            public bool ready;
        }

        private readonly CookingGraphAsset _graph;
        private EstimatorBotSettings _settings;
        private readonly Dictionary<IngredientNodeAsset, ProcessStep> _producer = new Dictionary<IngredientNodeAsset, ProcessStep>();
        private readonly Dictionary<IngredientNodeAsset, ProcessStep> _consumer = new Dictionary<IngredientNodeAsset, ProcessStep>();
        private readonly List<ProcessStep> _processSteps = new List<ProcessStep>();
        private readonly Dictionary<IngredientNodeAsset, Dictionary<IngredientNodeAsset, float>> _requirements = new Dictionary<IngredientNodeAsset, Dictionary<IngredientNodeAsset, float>>();
        private readonly Dictionary<IngredientNodeAsset, int> _depths = new Dictionary<IngredientNodeAsset, int>();
        private readonly Dictionary<IngredientNodeAsset, bool> _multiInputRoutes = new Dictionary<IngredientNodeAsset, bool>();
        private readonly Dictionary<IngredientNodeAsset, int> _terminalYields = new Dictionary<IngredientNodeAsset, int>();
        private readonly Dictionary<CompositeNodeAsset, List<PreviewSlot>> _previewSlots = new Dictionary<CompositeNodeAsset, List<PreviewSlot>>();
        private readonly HashSet<IngredientNodeAsset> _servable = new HashSet<IngredientNodeAsset>();

        public EstimatorBotScorer(CookingGraphAsset graph, EstimatorBotSettings settings)
        {
            _graph = graph ?? throw new ArgumentNullException(nameof(graph));
            _settings = settings ?? new EstimatorBotSettings();
            BuildIndex();
        }

        public void SetSettings(EstimatorBotSettings settings)
        {
            _settings = settings ?? throw new ArgumentNullException(nameof(settings));
        }

        public BotDecision Decide(
            BotGameState state,
            ISet<string> reservedItemIds,
            IEnumerable<BotCommittedIngredientState> optimisticCommitted,
            Random random,
            float intelligent)
        {
            if (state == null || !state.isPlaying) return null;
            var candidates = (state.pickupables ?? new List<BotPickupOption>())
                .Where(value => value != null && value.queueIndex >= 0 && !string.IsNullOrEmpty(value.itemId))
                .Where(value => IsVisiblyEligible(value, state))
                .Where(value => reservedItemIds == null || !ConsumedIds(value).Any(reservedItemIds.Contains))
                .OrderBy(value => value.queueIndex)
                .ToList();
            if (candidates.Count == 0) return null;

            var free = 0;
            var dirty = 0;
            var cells = state.grid != null && state.grid.cells != null
                ? state.grid.cells
                : new List<BotGridCellState>();
            foreach (var cell in cells)
            {
                if (cell == null || (cell.kind == BotGridItemKind.Empty && cell.canHoldItem)) free++;
                else if (cell.kind == BotGridItemKind.Dirty) dirty++;
            }
            var gridTight = cells.Count > 0 && free <= cells.Count * _settings.gridTightThreshold;
            var values = BuildPickupValues(state, reservedItemIds, optimisticCommitted, gridTight);
            var depth = _settings.visibleLookaheadRows > 0
                ? _settings.visibleLookaheadRows
                : Math.Max(1, _graph.map != null ? _graph.map.visibleRows : 1);

            var randomSource = random ?? new Random(_settings.randomSeed);
            if (UsesRandomChoice(intelligent, randomSource))
            {
                var option = candidates[randomSource.Next(candidates.Count)];
                var value = ScoreCandidate(option, state, values, dirty, gridTight, depth, reservedItemIds);
                return new BotDecision
                {
                    option = option,
                    score = value.score,
                    randomFallback = true,
                    customerIndex = value.customerIndex
                };
            }

            BotPickupOption bestOption = null;
            var best = new CandidateValue { customerIndex = -1 };
            foreach (var candidate in candidates)
            {
                var value = ScoreCandidate(candidate, state, values, dirty, gridTight, depth, reservedItemIds);
                if (value.score <= best.score) continue;
                best = value;
                bestOption = candidate;
            }

            if (bestOption != null)
            {
                return new BotDecision
                {
                    option = bestOption,
                    score = best.score,
                    randomFallback = false,
                    customerIndex = best.customerIndex
                };
            }

            BotPickupOption fallback;
            if (gridTight)
            {
                fallback = candidates
                    .OrderBy(value => value.picksSweeper ? -1 : EstimateFootprint(value, state))
                    .ThenBy(value => value.queueIndex)
                    .First();
            }
            else
            {
                fallback = candidates[randomSource.Next(candidates.Count)];
            }
            return new BotDecision { option = fallback, randomFallback = true, customerIndex = FirstCustomer(state) };
        }

        private static bool UsesRandomChoice(float intelligent, Random random)
        {
            if (intelligent <= 0) return true;
            if (intelligent >= 1) return false;
            return random.NextDouble() >= intelligent;
        }

        private Dictionary<IngredientNodeAsset, PickupValue> BuildPickupValues(
            BotGameState state,
            ISet<string> reservedItemIds,
            IEnumerable<BotCommittedIngredientState> optimisticCommitted,
            bool gridTight)
        {
            var cooked = new Dictionary<IngredientNodeAsset, float>();
            var committed = new Dictionary<IngredientNodeAsset, float>();
            var cells = state.grid != null ? state.grid.cells : null;
            foreach (var cell in cells ?? new List<BotGridCellState>())
            {
                if (cell == null) continue;
                if (cell.kind == BotGridItemKind.Cooked && cell.ingredient != null)
                    Add(cooked, cell.ingredient, Math.Max(1, cell.usesLeft));
                else if (cell.kind == BotGridItemKind.Raw && cell.ingredient != null)
                    AddRequirements(committed, cell.ingredient, 1);
                else if (cell.kind == BotGridItemKind.Backpack && state.saveMeBag == null)
                    foreach (var ingredient in cell.ingredients ?? new List<IngredientNodeAsset>())
                        AddRequirements(committed, ingredient, 1);
            }
            if (state.saveMeBag != null)
            {
                foreach (var item in state.saveMeBag.items ?? new List<BotSaveMeBagItemState>())
                    if (item != null) AddRequirements(committed, item.ingredient, 1);
            }
            foreach (var value in (state.committedIngredients ?? new List<BotCommittedIngredientState>())
                .Concat(optimisticCommitted ?? Enumerable.Empty<BotCommittedIngredientState>()))
            {
                if (value != null) AddRequirements(committed, value.ingredient, Math.Max(0, value.amount));
            }

            var units = new List<DemandUnit>();
            var activeCustomers = state.customerOrders ?? new List<BotCustomerOrderState>();
            for (var customerPosition = 0; customerPosition < activeCustomers.Count; customerPosition++)
            {
                var customer = activeCustomers[customerPosition];
                if (customer == null || customer.isStaff) continue;
                foreach (var dish in customer.dishes ?? new List<BotDishOrderState>())
                {
                    if (dish == null) continue;
                    var remaining = (dish.slots ?? new List<BotOrderSlotState>()).Count(slot => slot != null && !slot.filled);
                    foreach (var slot in dish.slots ?? new List<BotOrderSlotState>())
                    {
                        if (slot == null || slot.filled || slot.ingredient == null) continue;
                        var multiInput = HasMultiInputRoute(slot.ingredient, new HashSet<IngredientNodeAsset>());
                        var priority = slot.isBase
                            ? _settings.scoreBase
                            : slot.gateOpen
                                ? _settings.scoreReady
                                : gridTight ? _settings.scoreBlockedTight : _settings.scoreBlocked;
                        priority += Math.Min(_settings.depthBonusCap, ProductionDepth(slot.ingredient, new HashSet<IngredientNodeAsset>()) * _settings.depthBonusPerLevel);
                        if (multiInput) priority += slot.isBase ? _settings.multiInputBaseBonus : _settings.multiInputBonus;
                        priority += Math.Max(0, 4 - remaining) * _settings.nearCompletionBonus;
                        priority /= 1 + customerPosition * _settings.customerPositionDecay;
                        units.Add(new DemandUnit
                        {
                            target = slot.ingredient,
                            customerIndex = customer.customerIndex,
                            priority = priority,
                            multiInput = multiInput,
                            ready = slot.isBase || slot.gateOpen,
                            requirements = RawRequirements(slot.ingredient, new HashSet<IngredientNodeAsset>())
                        });
                    }
                }
            }

            units.Sort((a, b) => b.priority.CompareTo(a.priority));
            var unsatisfied = new List<DemandUnit>();
            foreach (var unit in units)
            {
                float have;
                if (cooked.TryGetValue(unit.target, out have) && have > 0)
                    cooked[unit.target] = have - 1;
                else
                    unsatisfied.Add(unit);
            }

            var claims = new Dictionary<IngredientNodeAsset, List<DemandClaim>>();
            foreach (var unit in unsatisfied)
            {
                foreach (var pair in unit.requirements)
                {
                    List<DemandClaim> list;
                    if (!claims.TryGetValue(pair.Key, out list))
                    {
                        list = new List<DemandClaim>();
                        claims.Add(pair.Key, list);
                    }
                    list.Add(new DemandClaim
                    {
                        units = pair.Value,
                        priority = unit.priority,
                        customerIndex = unit.customerIndex,
                        ready = unit.ready
                    });
                }
            }
            foreach (var list in claims.Values) list.Sort((a, b) => b.priority.CompareTo(a.priority));

            foreach (var supply in committed)
            {
                var left = supply.Value;
                List<DemandClaim> list;
                if (!claims.TryGetValue(supply.Key, out list)) continue;
                foreach (var claim in list)
                {
                    if (left <= 0) break;
                    var used = Math.Min(left, claim.units);
                    claim.units -= used;
                    left -= used;
                }
            }

            var previewClaims = BuildPreviewClaims(state, activeCustomers.Count);
            var queueSupply = QueueSupply(state, reservedItemIds);
            var ingredients = new HashSet<IngredientNodeAsset>();
            foreach (var lane in state.visibleQueues ?? new List<BotQueueLaneState>())
                if (lane != null)
                    foreach (var item in lane.items ?? new List<BotQueueItemState>())
                        if (item != null && item.ingredient != null) ingredients.Add(item.ingredient);
            foreach (var option in state.pickupables ?? new List<BotPickupOption>())
                if (option != null)
                    foreach (var ingredient in option.ingredients ?? new List<IngredientNodeAsset>())
                        if (ingredient != null) ingredients.Add(ingredient);

            var result = new Dictionary<IngredientNodeAsset, PickupValue>();
            foreach (var ingredient in ingredients)
            {
                var contribution = RawRequirements(ingredient, new HashSet<IngredientNodeAsset>());
                var score = 0f;
                var strongest = 0f;
                var customerIndex = -1;
                var ready = false;
                foreach (var part in contribution)
                {
                    var capacity = part.Value;
                    var leafScore = 0f;
                    List<DemandClaim> list;
                    if (!claims.TryGetValue(part.Key, out list)) list = EmptyClaims;
                    foreach (var claim in list)
                    {
                        if (capacity <= 0) break;
                        if (claim.units <= 0) continue;
                        var used = Math.Min(capacity, claim.units);
                        leafScore += claim.priority * used;
                        capacity -= used;
                        if (claim.priority > strongest)
                        {
                            strongest = claim.priority;
                            customerIndex = claim.customerIndex;
                            ready = claim.ready;
                        }
                    }
                    var needed = list.Sum(claim => Math.Max(0, claim.units));
                    float available;
                    queueSupply.TryGetValue(part.Key, out available);
                    if (needed > 0 && available > 0)
                        leafScore *= 1 + Math.Min(_settings.scarcityCap, needed / available * _settings.scarcityFactor);
                    score += leafScore;

                    PickupValue preview;
                    if (previewClaims.TryGetValue(part.Key, out preview))
                    {
                        var previewScore = preview.score * part.Value;
                        score += previewScore;
                        if (strongest == 0 && previewScore > 0) customerIndex = preview.customerIndex;
                    }
                }

                if (score > 0)
                {
                    foreach (var unit in unsatisfied)
                    {
                        var candidateLeaves = contribution.Keys.Where(leaf => unit.requirements.ContainsKey(leaf)).ToList();
                        if (candidateLeaves.Count == 0) continue;
                        var otherReady = unit.requirements.All(pair => candidateLeaves.Contains(pair.Key) || Amount(committed, pair.Key) >= pair.Value);
                        if (otherReady)
                            score += unit.priority * (unit.multiInput ? _settings.lastInputBonusMulti : _settings.lastInputBonusSingle);
                    }
                }
                result[ingredient] = new PickupValue { score = score, customerIndex = customerIndex, ready = ready };
            }
            return result;
        }

        private Dictionary<IngredientNodeAsset, PickupValue> BuildPreviewClaims(BotGameState state, int activeCount)
        {
            var result = new Dictionary<IngredientNodeAsset, PickupValue>();
            var previews = (state.previewOrders ?? new List<BotPreviewOrderState>()).Take(3).ToList();
            for (var previewPosition = 0; previewPosition < previews.Count; previewPosition++)
            {
                var customer = previews[previewPosition];
                if (customer == null || customer.isStaff) continue;
                foreach (var composite in customer.dishes ?? new List<CompositeNodeAsset>())
                {
                    if (composite == null) continue;
                    foreach (var slot in SlotsOf(composite))
                    {
                        if (slot.options.Count == 0) continue;
                        var confidence = slot.required ? _settings.previewConfidence : _settings.previewConfidence * 0.45f;
                        var priority = (slot.isBase ? _settings.scoreBase : _settings.scoreBlocked) * confidence;
                        priority /= 1 + (activeCount + previewPosition) * _settings.customerPositionDecay;
                        priority /= slot.options.Count;
                        foreach (var option in slot.options)
                        {
                            foreach (var leaf in RawRequirements(option, new HashSet<IngredientNodeAsset>()))
                            {
                                PickupValue current;
                                if (!result.TryGetValue(leaf.Key, out current)) current.customerIndex = -1;
                                current.score += priority * leaf.Value;
                                if (current.customerIndex < 0) current.customerIndex = customer.customerIndex;
                                result[leaf.Key] = current;
                            }
                        }
                    }
                }
            }
            return result;
        }

        private CandidateValue ScoreCandidate(
            BotPickupOption candidate,
            BotGameState state,
            IReadOnlyDictionary<IngredientNodeAsset, PickupValue> values,
            int dirty,
            bool gridTight,
            int depth,
            ISet<string> reservedItemIds)
        {
            var immediate = 0f;
            var strongest = 0f;
            var customerIndex = -1;
            var ready = false;
            if (candidate.picksSweeper && dirty > 0)
            {
                immediate = gridTight ? _settings.scoreSweeperUrgent : _settings.scoreSweeper;
                strongest = immediate;
                ready = true;
            }
            foreach (var ingredient in IngredientsOf(candidate, state))
            {
                PickupValue value;
                if (ingredient == null || !values.TryGetValue(ingredient, out value)) continue;
                immediate += value.score;
                if (value.score <= strongest) continue;
                strongest = value.score;
                customerIndex = value.customerIndex;
                ready = value.ready;
            }

            var future = 0f;
            var futureCustomer = -1;
            BotQueueLaneState lane = null;
            if (candidate.queueIndex >= 0 && candidate.queueIndex < (state.visibleQueues?.Count ?? 0))
                lane = state.visibleQueues[candidate.queueIndex];
            var items = lane != null ? lane.items : null;
            for (var row = 1; row < Math.Min(depth, items?.Count ?? 0); row++)
            {
                var item = items[row];
                if (item == null || item.kind != QueueItemKind.Ingredient || item.ingredient == null || item.status == BotQueueItemStatus.Departing) continue;
                if (_settings.respectHiddenStatus && item.status == BotQueueItemStatus.Hidden) continue;
                if (reservedItemIds != null && reservedItemIds.Contains(item.itemId)) continue;
                PickupValue value;
                if (!values.TryGetValue(item.ingredient, out value) || value.score <= 0) continue;
                var decayed = value.score * (float)Math.Pow(_settings.rowDecay, row);
                if (decayed <= future) continue;
                future = decayed;
                futureCustomer = value.customerIndex;
            }

            var footprint = EstimateFootprint(candidate, state);
            var penalty = immediate == 0 ? Math.Max(1, footprint) * (gridTight ? _settings.detourPenaltyTight : _settings.detourPenalty) : 0;
            return new CandidateValue
            {
                score = Math.Max(0, immediate + future - penalty),
                customerIndex = strongest > 0 ? customerIndex : futureCustomer,
                fromFront = strongest > 0,
                ready = strongest > 0 && ready
            };
        }

        internal int EstimateFootprint(BotPickupOption option, BotGameState state)
        {
            if (option.footprint > 0) return option.footprint;
            return IngredientsOf(option, state).Sum(TerminalYield);
        }

        /// <summary>
        /// Convert logical in-flight/tool amounts into their eventual grid footprint. Counting
        /// jobs alone underestimates batch recipes whose single input produces multiple outputs.
        /// </summary>
        internal int EstimateCommittedFootprint(IEnumerable<BotCommittedIngredientState> ingredients)
        {
            return EstimatePipelineFootprint(CommittedInventory(ingredients));
        }

        /// <summary>
        /// Projects state commitments, the bot's one-frame reservations, and a candidate together.
        /// This is important for multi-input tools: complementary inputs produce one output and
        /// must not each be counted as an independent future grid item.
        /// </summary>
        internal int EstimateProjectedFootprint(
            IEnumerable<BotCommittedIngredientState> stateCommitted,
            IEnumerable<BotCommittedIngredientState> optimisticPending,
            BotPickupOption candidate,
            BotGameState state)
        {
            var authoritative = CommittedInventory(stateCommitted);
            var optimistic = CommittedInventory(optimisticPending);
            foreach (var pair in optimistic)
            {
                float current;
                authoritative.TryGetValue(pair.Key, out current);
                authoritative[pair.Key] = Math.Max(current, pair.Value);
            }

            var withCandidate = new Dictionary<IngredientNodeAsset, float>(authoritative);
            if (candidate != null && !candidate.picksSweeper)
                foreach (var ingredient in IngredientsOf(candidate, state)) Add(withCandidate, ingredient, 1);
            var combined = EstimatePipelineFootprint(withCandidate);

            // A game adapter may know a linked/group pickup's footprint more accurately than the
            // graph. Preserve that override while retaining the reduction from combining inputs.
            if (candidate != null && candidate.footprint > 0 && !candidate.picksSweeper)
            {
                var candidateInventory = new Dictionary<IngredientNodeAsset, float>();
                foreach (var ingredient in IngredientsOf(candidate, state)) Add(candidateInventory, ingredient, 1);
                var graphCandidateFootprint = EstimatePipelineFootprint(candidateInventory);
                combined += candidate.footprint - graphCandidateFootprint;
            }
            return Math.Max(0, combined);
        }

        private static Dictionary<IngredientNodeAsset, float> CommittedInventory(
            IEnumerable<BotCommittedIngredientState> ingredients)
        {
            var result = new Dictionary<IngredientNodeAsset, float>();
            foreach (var value in ingredients ?? Enumerable.Empty<BotCommittedIngredientState>())
                if (value != null && value.ingredient != null)
                    Add(result, value.ingredient, Math.Max(0, value.amount));
            return result;
        }

        private int EstimatePipelineFootprint(Dictionary<IngredientNodeAsset, float> source)
        {
            var inventory = new Dictionary<IngredientNodeAsset, float>(source);
            // Valid graphs are acyclic. The guard also makes malformed cyclic graph data harmless.
            var changed = true;
            var remainingPasses = Math.Max(1, _processSteps.Count * 2 + 1);
            while (changed && remainingPasses-- > 0)
            {
                changed = false;
                foreach (var step in _processSteps)
                {
                    if (step == null || step.output == null || step.inputs.Count == 0) continue;
                    var required = new Dictionary<IngredientNodeAsset, int>();
                    foreach (var input in step.inputs)
                    {
                        if (input == null) continue;
                        int count;
                        required.TryGetValue(input, out count);
                        required[input] = count + 1;
                    }
                    if (required.Count == 0 || required.ContainsKey(step.output)) continue;

                    var batches = float.PositiveInfinity;
                    foreach (var pair in required)
                    {
                        float available;
                        inventory.TryGetValue(pair.Key, out available);
                        batches = Math.Min(batches, available / pair.Value);
                    }
                    if (float.IsInfinity(batches)) continue;
                    batches = (float)Math.Floor(batches + 0.0001f);
                    if (batches <= 0) continue;

                    foreach (var pair in required)
                        inventory[pair.Key] = Math.Max(0, inventory[pair.Key] - batches * pair.Value);
                    Add(inventory, step.output, batches * Math.Max(1, step.amount));
                    changed = true;
                }
            }

            return (int)Math.Ceiling(inventory.Sum(pair =>
                Math.Max(0, pair.Value) * TerminalYield(pair.Key)));
        }

        private IEnumerable<IngredientNodeAsset> IngredientsOf(BotPickupOption option, BotGameState state)
        {
            if (option.ingredients != null && option.ingredients.Count > 0) return option.ingredients.Where(value => value != null);
            if (option.queueIndex < 0 || option.queueIndex >= (state.visibleQueues?.Count ?? 0)) return Enumerable.Empty<IngredientNodeAsset>();
            var lane = state.visibleQueues[option.queueIndex];
            var item = lane?.items?.FirstOrDefault(value => value != null && value.itemId == option.itemId);
            return item?.ingredient != null ? new[] { item.ingredient } : Enumerable.Empty<IngredientNodeAsset>();
        }

        private Dictionary<IngredientNodeAsset, float> QueueSupply(BotGameState state, ISet<string> reservedItemIds)
        {
            var result = new Dictionary<IngredientNodeAsset, float>();
            foreach (var lane in state.visibleQueues ?? new List<BotQueueLaneState>())
            {
                if (lane == null) continue;
                foreach (var item in lane.items ?? new List<BotQueueItemState>())
                {
                    if (item == null || item.kind != QueueItemKind.Ingredient || item.ingredient == null || item.status == BotQueueItemStatus.Departing) continue;
                    if (reservedItemIds != null && reservedItemIds.Contains(item.itemId)) continue;
                    AddRequirements(result, item.ingredient, 1);
                }
            }
            return result;
        }

        private Dictionary<IngredientNodeAsset, float> RawRequirements(IngredientNodeAsset ingredient, HashSet<IngredientNodeAsset> visiting)
        {
            if (ingredient == null) return new Dictionary<IngredientNodeAsset, float>();
            Dictionary<IngredientNodeAsset, float> cached;
            if (_requirements.TryGetValue(ingredient, out cached)) return cached;
            if (!visiting.Add(ingredient) || !_producer.ContainsKey(ingredient))
            {
                var leaf = new Dictionary<IngredientNodeAsset, float> { [ingredient] = 1 };
                _requirements[ingredient] = leaf;
                return leaf;
            }
            var step = _producer[ingredient];
            var result = new Dictionary<IngredientNodeAsset, float>();
            foreach (var input in step.inputs)
                foreach (var pair in RawRequirements(input, visiting))
                    Add(result, pair.Key, pair.Value / Math.Max(1, step.amount));
            visiting.Remove(ingredient);
            _requirements[ingredient] = result;
            return result;
        }

        private int ProductionDepth(IngredientNodeAsset ingredient, HashSet<IngredientNodeAsset> visiting)
        {
            int cached;
            if (_depths.TryGetValue(ingredient, out cached)) return cached;
            ProcessStep step;
            if (ingredient == null || !visiting.Add(ingredient) || !_producer.TryGetValue(ingredient, out step)) return 0;
            var depth = 1 + (step.inputs.Count == 0 ? 0 : step.inputs.Max(input => ProductionDepth(input, visiting)));
            visiting.Remove(ingredient);
            _depths[ingredient] = depth;
            return depth;
        }

        private bool HasMultiInputRoute(IngredientNodeAsset ingredient, HashSet<IngredientNodeAsset> visiting)
        {
            bool cached;
            if (_multiInputRoutes.TryGetValue(ingredient, out cached)) return cached;
            ProcessStep step;
            if (ingredient == null || !visiting.Add(ingredient) || !_producer.TryGetValue(ingredient, out step)) return false;
            var result = step.inputs.Count > 1 || step.inputs.Any(input => HasMultiInputRoute(input, visiting));
            visiting.Remove(ingredient);
            _multiInputRoutes[ingredient] = result;
            return result;
        }

        private int TerminalYield(IngredientNodeAsset ingredient)
        {
            int cached;
            if (ingredient == null) return 1;
            if (_terminalYields.TryGetValue(ingredient, out cached)) return cached;
            return ResolveTerminalYield(ingredient, new HashSet<IngredientNodeAsset>());
        }

        private int ResolveTerminalYield(IngredientNodeAsset ingredient, HashSet<IngredientNodeAsset> visiting)
        {
            int cached;
            if (_terminalYields.TryGetValue(ingredient, out cached)) return cached;
            ProcessStep step;
            if (_servable.Contains(ingredient) || !visiting.Add(ingredient) || !_consumer.TryGetValue(ingredient, out step))
            {
                _terminalYields[ingredient] = 1;
                return 1;
            }
            var value = Math.Max(1, step.amount) * ResolveTerminalYield(step.output, visiting);
            visiting.Remove(ingredient);
            _terminalYields[ingredient] = value;
            return value;
        }

        private List<PreviewSlot> SlotsOf(CompositeNodeAsset composite)
        {
            List<PreviewSlot> cached;
            if (_previewSlots.TryGetValue(composite, out cached)) return cached;
            var result = new List<PreviewSlot>();
            WalkComposite(composite, true, composite != null && composite.toppingRequired, result, new HashSet<CookingNodeAsset>());
            _previewSlots[composite] = result;
            return result;
        }

        private void WalkComposite(CompositeNodeAsset composite, bool isBase, bool rootToppingRequired, List<PreviewSlot> output, HashSet<CookingNodeAsset> visiting)
        {
            if (composite == null || !visiting.Add(composite)) return;
            foreach (var edge in _graph.baseEdges ?? new List<NodeEdgeAssetData>())
                if (edge != null && edge.from == composite) WalkSlotNode(edge.to, isBase, rootToppingRequired, output, visiting);
            foreach (var edge in _graph.toppingEdges ?? new List<NodeEdgeAssetData>())
                if (edge != null && edge.from == composite) WalkSlotNode(edge.to, false, rootToppingRequired, output, visiting);
            visiting.Remove(composite);
        }

        private void WalkSlotNode(CookingNodeAsset node, bool isBase, bool rootToppingRequired, List<PreviewSlot> output, HashSet<CookingNodeAsset> visiting)
        {
            var ingredient = node as IngredientNodeAsset;
            if (ingredient != null)
            {
                var slot = new PreviewSlot { isBase = isBase, required = isBase || rootToppingRequired };
                slot.options.Add(ingredient);
                output.Add(slot);
                return;
            }
            var composite = node as CompositeNodeAsset;
            if (composite != null)
            {
                WalkComposite(composite, isBase, rootToppingRequired, output, visiting);
                return;
            }
            var group = node as GroupNodeAsset;
            if (group == null || !visiting.Add(group)) return;
            var groupSlot = new PreviewSlot { isBase = isBase, required = isBase || group.minQuantity > 0 || rootToppingRequired };
            foreach (var edge in _graph.optionEdges ?? new List<OptionEdgeAssetData>())
            {
                if (edge == null || edge.from != group) continue;
                var direct = edge.to as IngredientNodeAsset;
                if (direct != null) groupSlot.options.Add(direct);
                else WalkSlotNode(edge.to, isBase, rootToppingRequired, output, visiting);
            }
            if (groupSlot.options.Count > 0) output.Add(groupSlot);
            visiting.Remove(group);
        }

        private void BuildIndex()
        {
            foreach (var edge in _graph.processEdges ?? new List<ProcessEdgeAssetData>())
            {
                if (edge == null || edge.to == null) continue;
                var step = new ProcessStep { output = edge.to, amount = Math.Max(1, edge.amount) };
                foreach (var input in edge.inputs ?? new List<ProcessInputAssetData>())
                    if (input != null && input.ingredient != null) step.inputs.Add(input.ingredient);
                if (!_producer.ContainsKey(step.output)) _producer.Add(step.output, step);
                _processSteps.Add(step);
                foreach (var input in step.inputs)
                    if (!_consumer.ContainsKey(input)) _consumer.Add(input, step);
            }
            foreach (var composite in _graph.composites ?? new List<CompositeNodeAsset>())
                if (composite != null)
                    foreach (var slot in SlotsOf(composite))
                        foreach (var ingredient in slot.options) _servable.Add(ingredient);
        }

        private static IEnumerable<string> ConsumedIds(BotPickupOption option)
        {
            if (option.consumedItemIds != null && option.consumedItemIds.Count > 0) return option.consumedItemIds.Where(value => !string.IsNullOrEmpty(value));
            return string.IsNullOrEmpty(option.itemId) ? Enumerable.Empty<string>() : new[] { option.itemId };
        }

        /// <summary>
        /// Defense in depth for a stale or overly permissive pickupables adapter. Hidden items may
        /// still be legal gambles, but frozen, locked, and departing items are never submitted.
        /// Every member of an atomic combined/linked pickup must be visible and eligible.
        /// </summary>
        private static bool IsVisiblyEligible(BotPickupOption option, BotGameState state)
        {
            if (option.queueIndex < 0 || option.queueIndex >= (state.visibleQueues?.Count ?? 0)) return false;
            var leaderLane = state.visibleQueues[option.queueIndex];
            var leader = leaderLane?.items?.FirstOrDefault(item => item != null && item.itemId == option.itemId);
            if (leader == null || IsBlockedStatus(leader.status)) return false;

            var ids = new HashSet<string>(ConsumedIds(option), StringComparer.Ordinal);
            ids.Add(option.itemId);
            foreach (var id in ids)
            {
                BotQueueItemState item = null;
                foreach (var lane in state.visibleQueues)
                {
                    item = lane?.items?.FirstOrDefault(value => value != null && value.itemId == id);
                    if (item != null) break;
                }
                if (item == null || IsBlockedStatus(item.status)) return false;
            }
            return true;
        }

        private static bool IsBlockedStatus(BotQueueItemStatus status)
        {
            return status == BotQueueItemStatus.Frozen ||
                   status == BotQueueItemStatus.Locked ||
                   status == BotQueueItemStatus.Departing;
        }

        private static int FirstCustomer(BotGameState state)
        {
            var customer = (state.customerOrders ?? new List<BotCustomerOrderState>()).FirstOrDefault(value => value != null && !value.isStaff)
                ?? (state.customerOrders ?? new List<BotCustomerOrderState>()).FirstOrDefault(value => value != null);
            return customer != null ? customer.customerIndex : -1;
        }

        private void AddRequirements(Dictionary<IngredientNodeAsset, float> target, IngredientNodeAsset ingredient, float scale)
        {
            if (ingredient == null || scale <= 0) return;
            foreach (var pair in RawRequirements(ingredient, new HashSet<IngredientNodeAsset>())) Add(target, pair.Key, pair.Value * scale);
        }

        private static float Amount(IReadOnlyDictionary<IngredientNodeAsset, float> values, IngredientNodeAsset ingredient)
        {
            float value;
            return ingredient != null && values.TryGetValue(ingredient, out value) ? value : 0;
        }

        private static void Add(Dictionary<IngredientNodeAsset, float> values, IngredientNodeAsset ingredient, float amount)
        {
            if (ingredient == null || amount == 0) return;
            float current;
            values.TryGetValue(ingredient, out current);
            values[ingredient] = current + amount;
        }

        private static readonly List<DemandClaim> EmptyClaims = new List<DemandClaim>();
    }
}
