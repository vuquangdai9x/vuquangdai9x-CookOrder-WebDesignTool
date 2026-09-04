using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using UnityEngine;

namespace CookingGraph
{
    /// <summary>
    /// Rebuilds the graph customer-order structure for an unordered, flat multiset of cooked
    /// ingredient indices. Only exact, structurally valid matches are returned.
    /// </summary>
    public static class CompositeStructureTranslator
    {
        private sealed class Slot
        {
            public bool fixedSlot;
            public bool isBase;
            public int maximum;
            public readonly List<CookingNodeAsset> containerPath = new List<CookingNodeAsset>();
            public readonly List<IngredientNodeAsset> options = new List<IngredientNodeAsset>();
            public readonly List<int> optionMaximums = new List<int>();
            public readonly List<CompositeNodeAsset> baseOf = new List<CompositeNodeAsset>();
            public readonly List<CompositeNodeAsset> requiresBaseOf = new List<CompositeNodeAsset>();
        }

        /// <summary>
        /// Returns the first exact composite structure in <see cref="CookingGraphAsset.idTable"/>
        /// order that consumes every supplied ingredient. Returns null when there is no exact
        /// match. If more than one distinct structure is valid, the first is returned and a
        /// warning is sent to <paramref name="onWarning"/>, or to <see cref="Debug.LogWarning(object)"/>
        /// when no callback is supplied.
        /// </summary>
        public static OrderMemberData Translate(
            CookingGraphAsset graph,
            IReadOnlyList<int> cookedIngredientIndices,
            Action<string> onWarning = null)
        {
            if (graph == null) throw new ArgumentNullException(nameof(graph));
            if (cookedIngredientIndices == null) throw new ArgumentNullException(nameof(cookedIngredientIndices));
            if (cookedIngredientIndices.Count == 0) return null;

            var ingredients = ResolveIngredients(graph, cookedIngredientIndices);
            var matches = new List<OrderMemberData>(2);
            var signatures = new HashSet<string>(StringComparer.Ordinal);
            var composites = graph.idTable?.composite;
            if (composites == null) return null;

            for (var compositeIndex = 0; compositeIndex < composites.Count && matches.Count < 2; compositeIndex++)
            {
                var composite = composites[compositeIndex];
                if (composite == null || !composite.orderable) continue;
                FindMatches(graph, composite, compositeIndex, ingredients, matches, signatures, 2);
            }

            if (matches.Count == 0) return null;
            if (matches.Count > 1)
            {
                var selected = matches[0].asset as CompositeNodeAsset;
                var selectedName = selected == null || string.IsNullOrEmpty(selected.nodeName)
                    ? $"composite index {matches[0].index}"
                    : $"'{selected.nodeName}' (composite index {matches[0].index})";
                Warn(onWarning,
                    $"Cooked ingredient indices [{string.Join(", ", cookedIngredientIndices)}] match multiple composite structures. " +
                    $"Using the first match {selectedName} in graph id-table order.");
            }
            return matches[0];
        }

        /// <summary>Try-pattern equivalent of <see cref="Translate"/>.</summary>
        public static bool TryTranslate(
            CookingGraphAsset graph,
            IReadOnlyList<int> cookedIngredientIndices,
            out OrderMemberData composite,
            Action<string> onWarning = null)
        {
            composite = Translate(graph, cookedIngredientIndices, onWarning);
            return composite != null;
        }

        /// <summary>
        /// Convenience method for callers that need only the matched graph asset rather than the
        /// reconstructed group/member tree.
        /// </summary>
        public static CompositeNodeAsset FindBestComposite(
            CookingGraphAsset graph,
            IReadOnlyList<int> cookedIngredientIndices,
            Action<string> onWarning = null)
        {
            return Translate(graph, cookedIngredientIndices, onWarning)?.asset as CompositeNodeAsset;
        }

        private static List<IngredientNodeAsset> ResolveIngredients(CookingGraphAsset graph, IReadOnlyList<int> cookedIngredientIndices)
        {
            var table = graph.idTable?.ingredient;
            var output = new List<IngredientNodeAsset>(cookedIngredientIndices.Count);
            for (var position = 0; position < cookedIngredientIndices.Count; position++)
            {
                var index = cookedIngredientIndices[position];
                if (table == null || index < 0 || index >= table.Count || table[index] == null)
                    throw new ArgumentOutOfRangeException(
                        nameof(cookedIngredientIndices),
                        index,
                        $"Cooked ingredient at list position {position} has index {index}, which does not resolve through graph.idTable.ingredient.");
                output.Add(table[index]);
            }
            return output;
        }

        private static void FindMatches(
            CookingGraphAsset graph,
            CompositeNodeAsset composite,
            int compositeIndex,
            IReadOnlyList<IngredientNodeAsset> ingredients,
            ICollection<OrderMemberData> output,
            ISet<string> signatures,
            int limit)
        {
            var slots = SlotsOf(graph, composite);
            if (slots.Count == 0) return;

            var assignment = Enumerable.Repeat(-1, ingredients.Count).ToArray();
            var slotCounts = new int[slots.Count];
            var optionCounts = slots.Select(slot => new int[slot.options.Count]).ToArray();

            void Search(int ingredientPosition)
            {
                if (output.Count >= limit) return;
                if (ingredientPosition == ingredients.Count)
                {
                    if (!ValidSelection(composite, slots, assignment, slotCounts)) return;
                    var root = BuildStructure(graph, composite, compositeIndex, ingredients, slots, assignment);
                    if (root == null) return;
                    var signature = Signature(root);
                    if (signatures.Add(signature)) output.Add(root);
                    return;
                }

                var ingredient = ingredients[ingredientPosition];
                for (var slotIndex = 0; slotIndex < slots.Count; slotIndex++)
                {
                    var slot = slots[slotIndex];
                    var optionIndex = slot.options.IndexOf(ingredient);
                    if (optionIndex < 0 || slotCounts[slotIndex] >= Capacity(slot, ingredients.Count)) continue;
                    var optionMaximum = optionIndex < slot.optionMaximums.Count ? slot.optionMaximums[optionIndex] : -1;
                    if (optionMaximum > 0 && optionCounts[slotIndex][optionIndex] >= optionMaximum) continue;

                    assignment[ingredientPosition] = slotIndex;
                    slotCounts[slotIndex]++;
                    optionCounts[slotIndex][optionIndex]++;
                    Search(ingredientPosition + 1);
                    optionCounts[slotIndex][optionIndex]--;
                    slotCounts[slotIndex]--;
                    assignment[ingredientPosition] = -1;
                    if (output.Count >= limit) return;
                }
            }

            Search(0);
        }

        private static bool ValidSelection(
            CompositeNodeAsset rootComposite,
            IReadOnlyList<Slot> slots,
            IReadOnlyList<int> assignment,
            IReadOnlyList<int> slotCounts)
        {
            if (!slots.Select((slot, index) => new { slot, index })
                    .Any(value => value.slot.isBase && slotCounts[value.index] > 0))
                return false;

            if (rootComposite.toppingRequired && !slots.Select((slot, index) => new { slot, index })
                    .Any(value => !value.slot.isBase && slotCounts[value.index] > 0))
                return false;

            var selectedSlots = new HashSet<int>(assignment);
            foreach (var slotIndex in selectedSlots)
            {
                if (slotIndex < 0 || slotIndex >= slots.Count) return false;
                foreach (var requiredComposite in slots[slotIndex].requiresBaseOf)
                {
                    var hasBase = slots.Select((candidate, index) => new { candidate, index })
                        .Any(value => slotCounts[value.index] > 0 && value.candidate.baseOf.Contains(requiredComposite));
                    if (!hasBase) return false;
                }
            }

            foreach (var nested in slots.SelectMany(slot => slot.baseOf).Distinct())
            {
                if (nested == null || !nested.toppingRequired) continue;
                var hasBase = slots.Select((slot, index) => new { slot, index })
                    .Any(value => slotCounts[value.index] > 0 && value.slot.baseOf.Contains(nested));
                if (!hasBase) continue;
                var hasTopping = slots.Select((slot, index) => new { slot, index })
                    .Any(value => slotCounts[value.index] > 0 && value.slot.requiresBaseOf.Contains(nested));
                if (!hasTopping) return false;
            }

            return true;
        }

        private static OrderMemberData BuildStructure(
            CookingGraphAsset graph,
            CompositeNodeAsset composite,
            int compositeIndex,
            IReadOnlyList<IngredientNodeAsset> ingredients,
            IReadOnlyList<Slot> slots,
            IReadOnlyList<int> assignment)
        {
            if (compositeIndex < 0) return null;
            var root = Member(OrderMemberKind.Composite, compositeIndex, composite);
            var containers = new Dictionary<string, OrderMemberData>(StringComparer.Ordinal);

            for (var slotIndex = 0; slotIndex < slots.Count; slotIndex++)
            {
                var slot = slots[slotIndex];
                for (var ingredientPosition = 0; ingredientPosition < assignment.Count; ingredientPosition++)
                {
                    if (assignment[ingredientPosition] != slotIndex) continue;
                    var container = root;
                    var key = new StringBuilder();
                    foreach (var node in slot.containerPath)
                    {
                        int nodeIndex;
                        OrderMemberKind nodeKind;
                        if (node is GroupNodeAsset group)
                        {
                            nodeIndex = graph.idTable.group.IndexOf(group);
                            nodeKind = OrderMemberKind.Group;
                        }
                        else if (node is CompositeNodeAsset nestedComposite)
                        {
                            nodeIndex = graph.idTable.composite.IndexOf(nestedComposite);
                            nodeKind = OrderMemberKind.Composite;
                        }
                        else
                        {
                            return null;
                        }
                        if (nodeIndex < 0) return null;
                        if (key.Length > 0) key.Append('/');
                        key.Append(nodeKind == OrderMemberKind.Group ? 'g' : 'c');
                        key.Append(nodeIndex.ToString(CultureInfo.InvariantCulture));
                        var pathKey = key.ToString();
                        if (!containers.TryGetValue(pathKey, out var nodeMember))
                        {
                            nodeMember = Member(nodeKind, nodeIndex, node);
                            container.members.Add(nodeMember);
                            containers.Add(pathKey, nodeMember);
                        }
                        container = nodeMember;
                    }

                    var ingredient = ingredients[ingredientPosition];
                    var ingredientIndex = graph.idTable.ingredient.IndexOf(ingredient);
                    if (ingredientIndex < 0) return null;
                    container.members.Add(Member(OrderMemberKind.Ingredient, ingredientIndex, ingredient));
                }
            }

            var data = new CustomerOrderData
            {
                customers = new List<CustomerData>
                {
                    new CustomerData
                    {
                        dishes = new List<DishOrderData> { new DishOrderData { root = root } }
                    }
                }
            };
            return CustomerOrderTranslator.ValidateGroupQuantities(data, graph).Count == 0 ? root : null;
        }

        private static List<Slot> SlotsOf(CookingGraphAsset graph, CompositeNodeAsset composite)
        {
            var output = new List<Slot>();
            var visiting = new HashSet<CookingNodeAsset>();

            void Walk(
                CookingNodeAsset node,
                bool isBase,
                IReadOnlyList<CookingNodeAsset> containerPath,
                IReadOnlyList<CompositeNodeAsset> baseOf,
                IReadOnlyList<CompositeNodeAsset> requiresBaseOf)
            {
                if (node == null || !visiting.Add(node)) return;
                if (node is IngredientNodeAsset ingredient)
                {
                    var slot = new Slot { fixedSlot = true, maximum = 1, isBase = isBase };
                    slot.containerPath.AddRange(containerPath);
                    slot.options.Add(ingredient);
                    slot.optionMaximums.Add(1);
                    slot.baseOf.AddRange(baseOf);
                    slot.requiresBaseOf.AddRange(requiresBaseOf);
                    output.Add(slot);
                }
                else if (node is GroupNodeAsset group)
                {
                    var path = containerPath.Concat(new CookingNodeAsset[] { group }).ToList();
                    var slot = new Slot
                    {
                        fixedSlot = false,
                        maximum = Optional(group.maxQuantity),
                        isBase = isBase
                    };
                    slot.containerPath.AddRange(path);
                    slot.baseOf.AddRange(baseOf);
                    slot.requiresBaseOf.AddRange(requiresBaseOf);
                    foreach (var edge in graph.optionEdges.Where(value => value?.from == group))
                    {
                        if (edge.to is IngredientNodeAsset option)
                        {
                            slot.options.Add(option);
                            slot.optionMaximums.Add(Optional(edge.maxQuantity));
                        }
                        else
                        {
                            Walk(edge.to, isBase, path, baseOf, requiresBaseOf);
                        }
                    }
                    if (slot.options.Count > 0) output.Add(slot);
                }
                else if (node is CompositeNodeAsset nested)
                {
                    var path = nested == composite
                        ? containerPath
                        : containerPath.Concat(new CookingNodeAsset[] { nested }).ToList();
                    var nestedBaseOf = baseOf.Concat(new[] { nested }).ToList();
                    foreach (var edge in graph.baseEdges.Where(value => value?.from == nested))
                        Walk(edge.to, isBase, path, nestedBaseOf, requiresBaseOf);
                    var nestedRequirement = requiresBaseOf.Concat(new[] { nested }).ToList();
                    foreach (var edge in graph.toppingEdges.Where(value => value?.from == nested))
                        Walk(edge.to, false, path, Array.Empty<CompositeNodeAsset>(), nestedRequirement);
                }
                visiting.Remove(node);
            }

            Walk(composite, true, Array.Empty<CookingNodeAsset>(), Array.Empty<CompositeNodeAsset>(), Array.Empty<CompositeNodeAsset>());
            return output;
        }

        private static int Capacity(Slot slot, int suppliedCount)
        {
            if (slot.fixedSlot) return 1;
            return slot.maximum < 0 ? suppliedCount : Math.Max(0, slot.maximum);
        }

        private static int Optional(OptionalInt value)
        {
            return value != null && value.hasValue ? value.value : -1;
        }

        private static OrderMemberData Member(OrderMemberKind kind, int index, CookingNodeAsset asset)
        {
            return new OrderMemberData { kind = kind, id = index, index = index, asset = asset };
        }

        private static string Signature(OrderMemberData member)
        {
            if (member.kind == OrderMemberKind.Ingredient)
                return "i" + member.index.ToString(CultureInfo.InvariantCulture);
            var prefix = member.kind == OrderMemberKind.Composite ? "c" : "g";
            return prefix + member.index.ToString(CultureInfo.InvariantCulture) +
                   "[" + string.Join(",", member.members.Select(Signature)) + "]";
        }

        private static void Warn(Action<string> onWarning, string message)
        {
            if (onWarning != null) onWarning(message);
            else Debug.LogWarning(message);
        }
    }
}
