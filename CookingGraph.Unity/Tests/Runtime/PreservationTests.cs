using NUnit.Framework;
using UnityEngine;

namespace CookingGraph.Tests
{
    public sealed class PreservationTests
    {
        [Test]
        public void WiredIngredientResolvesToItsToolBuffer()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var grinder = Node<ToolNodeAsset>("coffee-grinder");
            grinder.preservationSlots = 1;
            var bean = Node<IngredientNodeAsset>("coffee-bean");
            var unrelated = Node<IngredientNodeAsset>("milk");
            graph.tools.Add(grinder);
            graph.ingredients.AddRange(new[] { bean, unrelated });
            graph.preservationEdges.Add(new PreservationEdgeAssetData { from = grinder, to = bean });

            Assert.That(CookingGraphPreservation.IngredientsFor(graph, grinder), Is.EqualTo(new[] { bean }));
            Assert.That(CookingGraphPreservation.ToolsFor(graph, bean), Is.EqualTo(new[] { grinder }));
            Assert.That(CookingGraphPreservation.ToolsFor(graph, unrelated), Is.Empty);

            Destroy(graph, grinder, bean, unrelated);
        }

        [Test]
        public void WiredGroupExpandsThroughNestedOptionsWithoutDuplicates()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var fridge = Node<ToolNodeAsset>("fridge");
            fridge.preservationSlots = 2;
            var outer = Node<GroupNodeAsset>("chilled");
            var inner = Node<GroupNodeAsset>("berries");
            var milk = Node<IngredientNodeAsset>("milk");
            var kiwi = Node<IngredientNodeAsset>("kiwi");
            graph.tools.Add(fridge);
            graph.groups.AddRange(new[] { outer, inner });
            graph.ingredients.AddRange(new[] { milk, kiwi });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = outer, to = milk });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = outer, to = inner });
            // The same ingredient offered by both brackets must still be listed once: the buffer
            // accepts a SET, and a duplicate would double-count a free position.
            graph.optionEdges.Add(new OptionEdgeAssetData { from = inner, to = kiwi });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = inner, to = milk });
            graph.preservationEdges.Add(new PreservationEdgeAssetData { from = fridge, to = outer });

            Assert.That(CookingGraphPreservation.IngredientsFor(graph, fridge), Is.EqualTo(new[] { milk, kiwi }));
            Assert.That(CookingGraphPreservation.BuildLookup(graph)[fridge], Has.Count.EqualTo(2));

            Destroy(graph, fridge, outer, inner, milk, kiwi);
        }

        [Test]
        public void CyclicGroupWiringResolvesInsteadOfHanging()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var tool = Node<ToolNodeAsset>("tool");
            tool.preservationSlots = 1;
            var first = Node<GroupNodeAsset>("first");
            var second = Node<GroupNodeAsset>("second");
            var item = Node<IngredientNodeAsset>("item");
            graph.tools.Add(tool);
            graph.groups.AddRange(new[] { first, second });
            graph.ingredients.Add(item);
            graph.optionEdges.Add(new OptionEdgeAssetData { from = first, to = second });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = second, to = first });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = second, to = item });
            graph.preservationEdges.Add(new PreservationEdgeAssetData { from = tool, to = first });

            Assert.That(CookingGraphPreservation.IngredientsFor(graph, tool), Is.EqualTo(new[] { item }));

            Destroy(graph, tool, first, second, item);
        }

        [Test]
        public void ToolWithoutAPreservationEdgeAcceptsNothing()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var tool = Node<ToolNodeAsset>("griddle");
            graph.tools.Add(tool);

            Assert.That(tool.preservationSlots, Is.Zero);
            Assert.That(CookingGraphPreservation.IngredientsFor(graph, tool), Is.Empty);
            Assert.That(CookingGraphPreservation.BuildLookup(graph), Is.Empty);

            Destroy(graph, tool);
        }

        private static T Node<T>(string name) where T : CookingNodeAsset
        {
            var value = ScriptableObject.CreateInstance<T>();
            value.nodeName = name;
            value.displayName = name;
            return value;
        }

        private static void Destroy(params Object[] values)
        {
            foreach (var value in values) Object.DestroyImmediate(value);
        }
    }
}
