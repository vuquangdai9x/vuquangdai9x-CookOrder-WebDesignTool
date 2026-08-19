using System;
using System.Collections.Generic;
using System.Linq;

namespace CookingGraph
{
    /// <summary>Generates translator-ready ingredient queues from graph customer orders.</summary>
    public static class IngredientQueueGenerator
    {
        private sealed class LeafRequirement
        {
            public IngredientNodeAsset leaf;
            public int covers;
        }

        public static IngredientQueueData Generate(
            CookingGraphAsset graph,
            CustomerOrderData customers,
            int laneCount,
            QueueShuffleRange shuffleRange,
            Func<double> random = null)
        {
            if (graph == null) throw new ArgumentNullException(nameof(graph));
            if (customers == null) throw new ArgumentNullException(nameof(customers));
            random = random ?? (() => UnityEngine.Random.value);
            laneCount = Math.Max(1, laneCount);
            var lanes = Enumerable.Range(0, laneCount).Select(_ => new List<IngredientNodeAsset>()).ToList();
            var sequence = PickupSequence(graph, customers);
            for (var index = 0; index < sequence.Count; index++)
            {
                var ingredient = sequence[index];
                if (ingredient != null && graph.idTable.ingredient.IndexOf(ingredient) >= 0)
                    lanes[index % laneCount].Add(ingredient);
            }

            foreach (var lane in lanes)
            {
                if (shuffleRange == null) continue;
                if (shuffleRange.kind == QueueShuffleKind.Fixed)
                {
                    if (shuffleRange.value > 0) Displace(lane, _ => shuffleRange.value, random);
                }
                else
                {
                    var curve = shuffleRange.curve ?? new GenerationCurve();
                    var last = lane.Count - 1;
                    Displace(lane, index => Math.Max(0, (int)Math.Round(curve.Evaluate(last <= 0 ? 0 : (float)index / last), MidpointRounding.AwayFromZero)), random);
                }
            }

            var output = new IngredientQueueData();
            foreach (var lane in lanes)
            {
                var column = new IngredientQueueColumnData();
                foreach (var ingredient in lane)
                {
                    var id = graph.idTable.ingredient.IndexOf(ingredient);
                    column.items.Add(new QueueItemData
                    {
                        kind = QueueItemKind.Ingredient,
                        id = id,
                        index = id,
                        ingredient = ingredient
                    });
                }
                output.columns.Add(column);
            }
            return output;
        }

        public static string GenerateString(
            CookingGraphAsset graph,
            CustomerOrderData customers,
            int laneCount,
            QueueShuffleRange shuffleRange,
            Func<double> random = null)
        {
            return IngredientQueueTranslator.Serialize(Generate(graph, customers, laneCount, shuffleRange, random));
        }

        /// <summary>Pickup assets in true customer-arrival order before lane dealing and shuffling.</summary>
        public static IReadOnlyList<IngredientNodeAsset> PickupSequence(CookingGraphAsset graph, CustomerOrderData customers)
        {
            if (graph == null) throw new ArgumentNullException(nameof(graph));
            if (customers == null) throw new ArgumentNullException(nameof(customers));
            var remaining = new Dictionary<Tuple<IngredientNodeAsset, IngredientNodeAsset>, int>();
            var sequence = new List<IngredientNodeAsset>();
            foreach (var item in OrderedItems(graph, customers))
            {
                foreach (var requirement in LeavesFor(graph, item))
                {
                    var key = Tuple.Create(requirement.leaf, item);
                    var left = remaining.TryGetValue(key, out var value) ? value : 0;
                    if (left > 0)
                    {
                        remaining[key] = left - 1;
                        continue;
                    }
                    sequence.Add(requirement.leaf);
                    remaining[key] = Math.Max(0, requirement.covers - 1);
                }
            }
            return sequence;
        }

        private static IEnumerable<IngredientNodeAsset> OrderedItems(CookingGraphAsset graph, CustomerOrderData customers)
        {
            IEnumerable<IngredientNodeAsset> Walk(OrderMemberData member)
            {
                if (member == null) yield break;
                if (member.kind == OrderMemberKind.Ingredient)
                {
                    var asset = member.asset as IngredientNodeAsset;
                    var index = member.index >= 0 ? member.index : member.id;
                    if (asset == null && index >= 0 && index < graph.idTable.ingredient.Count) asset = graph.idTable.ingredient[index];
                    if (asset != null) yield return asset;
                    yield break;
                }
                foreach (var child in member.members ?? new List<OrderMemberData>())
                    foreach (var ingredient in Walk(child))
                        yield return ingredient;
            }

            foreach (var customer in customers.customers ?? new List<CustomerData>())
                foreach (var dish in customer?.dishes ?? new List<DishOrderData>())
                    foreach (var ingredient in Walk(dish?.root))
                        yield return ingredient;
        }

        private static IEnumerable<LeafRequirement> LeavesFor(CookingGraphAsset graph, IngredientNodeAsset ordered)
        {
            var uses = Math.Max(1, ordered?.usageNum ?? 1);
            var producer = new Dictionary<IngredientNodeAsset, ProcessEdgeAssetData>();
            foreach (var edge in graph.processEdges.Where(value => value?.to != null))
                if (!producer.ContainsKey(edge.to)) producer.Add(edge.to, edge);
            var output = new List<LeafRequirement>();

            void Walk(IngredientNodeAsset node, int yield, ISet<IngredientNodeAsset> seen)
            {
                if (node == null || seen.Contains(node)) return;
                if (node.pickupable || !producer.TryGetValue(node, out var step))
                {
                    output.Add(new LeafRequirement { leaf = node, covers = Math.Max(1, yield) * uses });
                    return;
                }
                var next = new HashSet<IngredientNodeAsset>(seen) { node };
                foreach (var input in step.inputs ?? new List<ProcessInputAssetData>())
                    Walk(input?.ingredient, yield * Math.Max(1, step.amount), next);
            }

            Walk(ordered, 1, new HashSet<IngredientNodeAsset>());
            return output;
        }

        private static void Displace<T>(IList<T> lane, Func<int, int> distanceAt, Func<double> random)
        {
            for (var index = lane.Count - 1; index > 0; index--)
            {
                var lowest = Math.Max(0, index - Math.Max(0, distanceAt(index)));
                var other = lowest + (int)Math.Floor(NextUnit(random) * (index - lowest + 1));
                var value = lane[index];
                lane[index] = lane[other];
                lane[other] = value;
            }
        }

        private static double NextUnit(Func<double> random)
        {
            return Math.Max(0, Math.Min(0.9999999999999999, random()));
        }
    }
}
