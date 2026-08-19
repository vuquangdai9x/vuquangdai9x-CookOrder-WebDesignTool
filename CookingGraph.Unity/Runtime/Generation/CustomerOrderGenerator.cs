using System;
using System.Collections.Generic;
using System.Linq;

namespace CookingGraph
{
    /// <summary>Graph-native customer generation equivalent to the web node editor's auto generator.</summary>
    public static class CustomerOrderGenerator
    {
        private sealed class Slot
        {
            public bool fixedSlot;
            public readonly List<GroupNodeAsset> groupPath = new List<GroupNodeAsset>();
            public readonly List<IngredientNodeAsset> options = new List<IngredientNodeAsset>();
            public readonly List<int> optionMaximums = new List<int>();
            public int maximum;
            public int minimum;
            public bool isBase;
        }

        public static CustomerOrderData Generate(
            CookingGraphAsset graph,
            CustomerOrderGenerationOptions options,
            Func<double> random = null,
            Action<string> onWarning = null)
        {
            if (graph == null) throw new ArgumentNullException(nameof(graph));
            if (options == null) throw new ArgumentNullException(nameof(options));
            random = random ?? (() => UnityEngine.Random.value);
            var maxDishSlots = Math.Max(1, options.maxDishSlots);
            var counts = options.dishCounts != null && options.dishCounts.Count > 0 ? options.dishCounts : new List<int> { 1 };
            var weights = BuildWeights(graph, options.weights);
            var slotsByComposite = graph.composites.Where(value => value != null)
                .ToDictionary(value => value, value => SlotsOf(graph, value));
            var candidates = graph.composites.Where(value => value != null && value.orderable)
                .Where(value => slotsByComposite.TryGetValue(value, out var slots) && slots.Any(slot => slot.options.Any(option => WeightOf(weights, option) > 0)))
                .ToList();
            var warned = new HashSet<string>(StringComparer.Ordinal);
            var output = new CustomerOrderData();

            for (var customerIndex = 0; customerIndex < counts.Count; customerIndex++)
            {
                var configuredCount = counts[customerIndex];
                if (configuredCount == -1)
                {
                    output.customers.Add(new CustomerData { typeId = 1, waitTime = 0, weatherEffect = 0, hasStaffAmount = true, staffAmount = 1 });
                    continue;
                }

                var curve = options.curve ?? new GenerationCurve();
                var curveRange = curve.range ?? new GenerationCurveRange();
                var realX = curveRange.minX + (counts.Count == 1 ? 0 : (float)customerIndex / (counts.Count - 1)) * (curveRange.maxX - curveRange.minX);
                var target = Math.Max(1, (int)Math.Round(curve.Evaluate(realX), MidpointRounding.AwayFromZero));
                var dishCount = configuredCount > 0 ? configuredCount : AutoDishCount(target, maxDishSlots);
                var perDish = Math.Max(1, (int)Math.Round((double)target / Math.Max(1, dishCount), MidpointRounding.AwayFromZero));
                var customer = new CustomerData { typeId = 0, waitTime = 0, weatherEffect = 0 };

                for (var dishIndex = 0; dishIndex < dishCount; dishIndex++)
                {
                    if (candidates.Count == 0) continue;
                    var composite = candidates[RandomIndex(candidates.Count, random)];
                    var dish = BuildDish(graph, composite, slotsByComposite[composite], perDish, weights, random, maxDishSlots);
                    if (dish != null) customer.dishes.Add(dish);
                    else
                    {
                        var warning = $"Could not generate {composite.nodeName}: enabled ingredients cannot satisfy its base and group minimum quantities.";
                        if (warned.Add(warning)) onWarning?.Invoke(warning);
                    }
                }
                output.customers.Add(customer);
            }
            return output;
        }

        public static string GenerateString(CookingGraphAsset graph, CustomerOrderGenerationOptions options, Func<double> random = null, Action<string> onWarning = null)
        {
            return CustomerOrderTranslator.Serialize(Generate(graph, options, random, onWarning));
        }

        private static int AutoDishCount(int target, int maxDishSlots)
        {
            return Math.Max(1, (int)Math.Round(target / ((1 + maxDishSlots) / 2.0), MidpointRounding.AwayFromZero));
        }

        private static Dictionary<IngredientNodeAsset, float> BuildWeights(CookingGraphAsset graph, IEnumerable<IngredientGenerationWeight> values)
        {
            var result = new Dictionary<IngredientNodeAsset, float>();
            foreach (var value in values ?? Enumerable.Empty<IngredientGenerationWeight>())
            {
                if (value == null) continue;
                var ingredient = value.ingredient;
                if (ingredient == null && value.index >= 0 && value.index < graph.ingredients.Count) ingredient = graph.ingredients[value.index];
                if (ingredient != null) result[ingredient] = Math.Max(0, value.weight);
            }
            return result;
        }

        private static float WeightOf(IReadOnlyDictionary<IngredientNodeAsset, float> weights, IngredientNodeAsset ingredient)
        {
            return ingredient != null && weights.TryGetValue(ingredient, out var value) ? Math.Max(0, value) : 0;
        }

        private static IngredientNodeAsset WeightedPick(IEnumerable<IngredientNodeAsset> options, IReadOnlyDictionary<IngredientNodeAsset, float> weights, Func<double> random)
        {
            var pool = options.Where(value => value != null && WeightOf(weights, value) > 0).ToList();
            var total = pool.Sum(value => WeightOf(weights, value));
            if (total <= 0) return null;
            var cursor = NextUnit(random) * total;
            foreach (var option in pool)
            {
                cursor -= WeightOf(weights, option);
                if (cursor <= 0) return option;
            }
            return pool[pool.Count - 1];
        }

        private static DishOrderData BuildDish(
            CookingGraphAsset graph,
            CompositeNodeAsset composite,
            IReadOnlyList<Slot> slots,
            int budget,
            IReadOnlyDictionary<IngredientNodeAsset, float> weights,
            Func<double> random,
            int maxDishSlots)
        {
            var compositeId = graph.idTable.composite.IndexOf(composite);
            if (compositeId < 0 || slots.Count == 0) return null;
            var root = Member(OrderMemberKind.Composite, compositeId, composite);
            var containers = new Dictionary<string, OrderMemberData>(StringComparer.Ordinal);
            var groupHeld = new Dictionary<GroupNodeAsset, int>();
            var held = Enumerable.Repeat(0, slots.Count).ToArray();

            int GroupCapacity(GroupNodeAsset group)
            {
                var maximum = Optional(group?.maxQuantity);
                return maximum < 0 ? maxDishSlots : Math.Max(0, maximum);
            }

            bool Put(int slotIndex, IngredientNodeAsset ingredient)
            {
                var slot = slots[slotIndex];
                var ingredientId = graph.idTable.ingredient.IndexOf(ingredient);
                if (ingredientId < 0) return false;
                var container = root;
                for (var depth = 0; depth < slot.groupPath.Count; depth++)
                {
                    var key = string.Join("/", slot.groupPath.Take(depth + 1).Select(value => value.nodeName));
                    if (!containers.TryGetValue(key, out var child))
                    {
                        if (depth > 0)
                        {
                            var parent = slot.groupPath[depth - 1];
                            if (Held(groupHeld, parent) >= GroupCapacity(parent)) return false;
                        }
                        var group = slot.groupPath[depth];
                        var groupId = graph.idTable.group.IndexOf(group);
                        if (groupId < 0) return false;
                        child = Member(OrderMemberKind.Group, groupId, group);
                        container.members.Add(child);
                        containers.Add(key, child);
                        if (depth > 0)
                        {
                            var parent = slot.groupPath[depth - 1];
                            groupHeld[parent] = Held(groupHeld, parent) + 1;
                        }
                    }
                    container = child;
                }
                if (slot.groupPath.Count > 0)
                {
                    var leafGroup = slot.groupPath[slot.groupPath.Count - 1];
                    if (Held(groupHeld, leafGroup) >= GroupCapacity(leafGroup)) return false;
                    groupHeld[leafGroup] = Held(groupHeld, leafGroup) + 1;
                }
                container.members.Add(Member(OrderMemberKind.Ingredient, ingredientId, ingredient));
                return true;
            }

            bool TryFill(int slotIndex)
            {
                var slot = slots[slotIndex];
                if (held[slotIndex] >= Capacity(slot, maxDishSlots)) return false;
                var eligible = slot.options.Where((option, index) =>
                {
                    var limit = index < slot.optionMaximums.Count ? slot.optionMaximums[index] : -1;
                    return limit <= 0 || CountOf(root, containers, slot, option) < limit;
                });
                var pick = WeightedPick(eligible, weights, random);
                if (pick == null || !Put(slotIndex, pick)) return false;
                held[slotIndex]++;
                return true;
            }

            var baseSlot = slots.Select((slot, index) => (slot, index)).Where(value => value.slot.isBase).Select(value => value.index).DefaultIfEmpty(-1).First();
            if (baseSlot >= 0 && slots[baseSlot].fixedSlot && !TryFill(baseSlot)) return null;
            for (var slotIndex = 0; slotIndex < slots.Count; slotIndex++)
            {
                var slot = slots[slotIndex];
                if (slot.fixedSlot) continue;
                var required = Math.Max(slot.minimum, slot.isBase ? 1 : 0);
                while (held[slotIndex] < required)
                    if (!TryFill(slotIndex)) return null;
            }

            var optional = Enumerable.Range(0, slots.Count).Where(index => index != baseSlot).ToList();
            if (composite.toppingRequired)
                foreach (var slotIndex in optional)
                    if (TryFill(slotIndex)) break;

            var remaining = Math.Max(0, budget - held.Sum());
            var guard = remaining * 4 + 8;
            while (remaining > 0 && optional.Count > 0 && guard-- > 0)
            {
                var slotIndex = optional[RandomIndex(optional.Count, random)];
                if (TryFill(slotIndex)) remaining--;
                else if (optional.All(index => held[index] >= Capacity(slots[index], maxDishSlots))) break;
            }
            return new DishOrderData { root = root };
        }

        private static int CountOf(OrderMemberData root, IReadOnlyDictionary<string, OrderMemberData> containers, Slot slot, IngredientNodeAsset option)
        {
            var key = string.Join("/", slot.groupPath.Select(value => value.nodeName));
            var container = containers.TryGetValue(key, out var value) ? value : root;
            return container.members.Count(member => member.kind == OrderMemberKind.Ingredient && member.asset == option);
        }

        private static int Held(IReadOnlyDictionary<GroupNodeAsset, int> held, GroupNodeAsset group)
        {
            return group != null && held.TryGetValue(group, out var value) ? value : 0;
        }

        private static int Capacity(Slot slot, int maximumDishSlots)
        {
            if (slot.fixedSlot) return 1;
            return slot.maximum < 0 ? maximumDishSlots : Math.Max(1, slot.maximum);
        }

        private static int Optional(OptionalInt value) => value != null && value.hasValue ? value.value : -1;

        private static OrderMemberData Member(OrderMemberKind kind, int id, CookingNodeAsset asset)
        {
            return new OrderMemberData { kind = kind, id = id, index = id, asset = asset };
        }

        private static List<Slot> SlotsOf(CookingGraphAsset graph, CompositeNodeAsset composite)
        {
            var output = new List<Slot>();
            var visiting = new HashSet<CookingNodeAsset>();
            void Walk(CookingNodeAsset node, bool isBase, IReadOnlyList<GroupNodeAsset> groupPath)
            {
                if (node == null || !visiting.Add(node)) return;
                if (node is IngredientNodeAsset ingredient)
                {
                    output.Add(new Slot { fixedSlot = true, maximum = 1, minimum = 0, isBase = isBase, options = { ingredient }, optionMaximums = { 1 } });
                }
                else if (node is GroupNodeAsset group)
                {
                    var path = groupPath.Concat(new[] { group }).ToList();
                    var slot = new Slot { fixedSlot = false, maximum = Optional(group.maxQuantity), minimum = Math.Max(0, group.minQuantity), isBase = isBase };
                    slot.groupPath.AddRange(path);
                    foreach (var edge in graph.optionEdges.Where(value => value?.from == group))
                    {
                        if (edge.to is IngredientNodeAsset option)
                        {
                            slot.options.Add(option);
                            slot.optionMaximums.Add(Optional(edge.maxQuantity));
                        }
                        else Walk(edge.to, isBase, path);
                    }
                    if (slot.options.Count > 0) output.Add(slot);
                }
                else if (node is CompositeNodeAsset nested)
                {
                    foreach (var edge in graph.baseEdges.Where(value => value?.from == nested)) Walk(edge.to, isBase, groupPath);
                    foreach (var edge in graph.toppingEdges.Where(value => value?.from == nested)) Walk(edge.to, false, groupPath);
                }
                visiting.Remove(node);
            }
            Walk(composite, true, Array.Empty<GroupNodeAsset>());
            return output;
        }

        private static int RandomIndex(int count, Func<double> random)
        {
            return Math.Min(count - 1, (int)Math.Floor(NextUnit(random) * count));
        }

        private static double NextUnit(Func<double> random)
        {
            return Math.Max(0, Math.Min(0.9999999999999999, random()));
        }
    }
}
