using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;

namespace CookingGraph.Tests
{
    public sealed class CompositeStructureTranslatorTests
    {
        [Test]
        public void FlatCookedIndicesBecomeAResolvedCompositeAndGroupTree()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var dish = Node<CompositeNodeAsset>("burger");
            var bun = Node<IngredientNodeAsset>("bun");
            var cheese = Node<IngredientNodeAsset>("cheese");
            var toppings = Node<GroupNodeAsset>("toppings");
            dish.orderable = true;
            toppings.minQuantity = 1;
            toppings.maxQuantity = Optional(2);
            Add(graph, dish, bun, cheese, toppings);

            var root = CompositeStructureTranslator.Translate(graph, new[] { 1, 0, 1 });

            Assert.That(root, Is.Not.Null);
            Assert.That(root.kind, Is.EqualTo(OrderMemberKind.Composite));
            Assert.That(root.index, Is.EqualTo(0));
            Assert.That(root.asset, Is.SameAs(dish));
            Assert.That(root.members[0].asset, Is.SameAs(bun));
            Assert.That(root.members[1].asset, Is.SameAs(toppings));
            Assert.That(root.members[1].members, Has.Count.EqualTo(2));
            Assert.That(root.members[1].members[0].asset, Is.SameAs(cheese));
            Assert.That(root.members[1].members[1].asset, Is.SameAs(cheese));
            Assert.That(CompositeStructureTranslator.FindBestComposite(graph, new[] { 0, 1 }), Is.SameAs(dish));

            Destroy(graph, dish, bun, cheese, toppings);
        }

        [Test]
        public void AmbiguousExactMatchesChooseFirstIdTableCompositeAndWarn()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var first = Node<CompositeNodeAsset>("first");
            var second = Node<CompositeNodeAsset>("second");
            var ingredient = Node<IngredientNodeAsset>("shared");
            first.orderable = true;
            second.orderable = true;
            graph.ingredients.Add(ingredient);
            graph.composites.AddRange(new[] { first, second });
            graph.idTable.ingredient.Add(ingredient);
            graph.idTable.composite.AddRange(new[] { first, second });
            graph.baseEdges.Add(new NodeEdgeAssetData { from = first, to = ingredient });
            graph.baseEdges.Add(new NodeEdgeAssetData { from = second, to = ingredient });
            var warnings = new List<string>();

            var root = CompositeStructureTranslator.Translate(graph, new[] { 0 }, warnings.Add);

            Assert.That(root.asset, Is.SameAs(first));
            Assert.That(root.index, Is.EqualTo(0));
            Assert.That(warnings, Has.Count.EqualTo(1));
            StringAssert.Contains("multiple composite structures", warnings[0]);
            StringAssert.Contains("first", warnings[0]);

            Destroy(graph, first, second, ingredient);
        }

        [Test]
        public void RequiresAnExactValidMatchAndPreservesDuplicateLimits()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var dish = Node<CompositeNodeAsset>("dish");
            var rice = Node<IngredientNodeAsset>("rice");
            var garnish = Node<IngredientNodeAsset>("garnish");
            var toppings = Node<GroupNodeAsset>("toppings");
            dish.orderable = true;
            dish.toppingRequired = true;
            toppings.minQuantity = 1;
            toppings.maxQuantity = Optional(2);
            Add(graph, dish, rice, garnish, toppings);
            graph.optionEdges[0].maxQuantity = Optional(1);

            Assert.That(CompositeStructureTranslator.Translate(graph, new[] { 0 }), Is.Null,
                "A required topping cannot be omitted.");
            Assert.That(CompositeStructureTranslator.Translate(graph, new[] { 0, 1, 1 }), Is.Null,
                "The per-option maximum must preserve duplicate counts.");
            Assert.That(CompositeStructureTranslator.TryTranslate(graph, new[] { 0, 1 }, out var root), Is.True);
            Assert.That(root, Is.Not.Null);
            Assert.That(CompositeStructureTranslator.TryTranslate(graph, new[] { 1 }, out root), Is.False,
                "A topping cannot match without the composite base.");

            Destroy(graph, dish, rice, garnish, toppings);
        }

        [Test]
        public void ReconstructsNestedCompositeContainersAndTheirRequirements()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var plate = Node<CompositeNodeAsset>("plate");
            var roll = Node<CompositeNodeAsset>("roll");
            var rice = Node<IngredientNodeAsset>("rice");
            var fish = Node<IngredientNodeAsset>("fish");
            plate.orderable = true;
            roll.toppingRequired = true;
            graph.ingredients.AddRange(new[] { rice, fish });
            graph.composites.AddRange(new[] { plate, roll });
            graph.idTable.ingredient.AddRange(new[] { rice, fish });
            graph.idTable.composite.AddRange(new[] { plate, roll });
            graph.baseEdges.Add(new NodeEdgeAssetData { from = plate, to = roll });
            graph.baseEdges.Add(new NodeEdgeAssetData { from = roll, to = rice });
            graph.toppingEdges.Add(new NodeEdgeAssetData { from = roll, to = fish });

            var root = CompositeStructureTranslator.Translate(graph, new[] { 0, 1 });

            Assert.That(root, Is.Not.Null);
            Assert.That(root.members, Has.Count.EqualTo(1));
            Assert.That(root.members[0].kind, Is.EqualTo(OrderMemberKind.Composite));
            Assert.That(root.members[0].asset, Is.SameAs(roll));
            Assert.That(root.members[0].members[0].asset, Is.SameAs(rice));
            Assert.That(root.members[0].members[1].asset, Is.SameAs(fish));
            Assert.That(CompositeStructureTranslator.Translate(graph, new[] { 0 }), Is.Null,
                "A selected nested composite must honor its own topping requirement.");

            Destroy(graph, plate, roll, rice, fish);
        }

        [Test]
        public void InvalidIngredientIndexIsRejected()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            Assert.Throws<System.ArgumentOutOfRangeException>(() =>
                CompositeStructureTranslator.Translate(graph, new[] { 7 }));
            Object.DestroyImmediate(graph);
        }

        private static void Add(
            CookingGraphAsset graph,
            CompositeNodeAsset dish,
            IngredientNodeAsset baseIngredient,
            IngredientNodeAsset topping,
            GroupNodeAsset group)
        {
            graph.ingredients.AddRange(new[] { baseIngredient, topping });
            graph.groups.Add(group);
            graph.composites.Add(dish);
            graph.idTable.ingredient.AddRange(new[] { baseIngredient, topping });
            graph.idTable.group.Add(group);
            graph.idTable.composite.Add(dish);
            graph.baseEdges.Add(new NodeEdgeAssetData { from = dish, to = baseIngredient });
            graph.toppingEdges.Add(new NodeEdgeAssetData { from = dish, to = group });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = group, to = topping });
        }

        private static T Node<T>(string name) where T : CookingNodeAsset
        {
            var value = ScriptableObject.CreateInstance<T>();
            value.nodeName = name;
            value.displayName = name;
            return value;
        }

        private static OptionalInt Optional(int value)
        {
            return new OptionalInt { hasValue = true, value = value };
        }

        private static void Destroy(params Object[] values)
        {
            foreach (var value in values) Object.DestroyImmediate(value);
        }
    }
}
