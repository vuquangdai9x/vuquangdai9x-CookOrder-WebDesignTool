using System.Linq;
using NUnit.Framework;
using UnityEngine;

namespace CookingGraph.Tests
{
    public sealed class CustomerOrderTranslatorTests
    {
        private const string TwoCustomers = "0;60;1;{c0:17.{g0:18.18.19}},{c1:24.8}|0;45;0;{c2:{g1:26}.{g2:14}}";

        [Test]
        public void NestedGraphOrdersRoundTrip()
        {
            var data = CustomerOrderTranslator.Parse(TwoCustomers);
            Assert.That(data.customers, Has.Count.EqualTo(2));
            Assert.That(data.customers[0].dishes, Has.Count.EqualTo(2));
            Assert.That(data.customers[0].dishes[0].root.kind, Is.EqualTo(OrderMemberKind.Composite));
            Assert.That(data.customers[0].dishes[0].root.members[1].kind, Is.EqualTo(OrderMemberKind.Group));
            Assert.That(CustomerOrderTranslator.Serialize(data), Is.EqualTo(TwoCustomers));
        }

        [Test]
        public void StaffAndEffectsRoundTrip()
        {
            const string source = "1;0;0;;3|0;30;0;{c12:117.{g34:234}}#4:1:2";
            var data = CustomerOrderTranslator.Parse(source);
            Assert.That(data.customers[0].hasStaffAmount, Is.True);
            Assert.That(data.customers[0].staffAmount, Is.EqualTo(3));
            Assert.That(data.customers[1].dishes[0].effects[0].parameters, Is.EqualTo(new[] { 1, 2 }));
            Assert.That(CustomerOrderTranslator.Serialize(data), Is.EqualTo(source));
        }

        [Test]
        public void RepetitionPreservesIngredientQuantity()
        {
            var root = CustomerOrderTranslator.Parse("0;0;0;{c0:17.{g0:18.18.19}}").customers[0].dishes[0].root;
            var ids = root.members[1].members.Select(member => member.id).ToArray();
            Assert.That(ids, Is.EqualTo(new[] { 18, 18, 19 }));
        }

        [Test]
        public void GraphAwareParseResolvesEveryMemberAssetAndIndex()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var composite = ScriptableObject.CreateInstance<CompositeNodeAsset>();
            var group = ScriptableObject.CreateInstance<GroupNodeAsset>();
            var baseIngredient = ScriptableObject.CreateInstance<IngredientNodeAsset>();
            var topping = ScriptableObject.CreateInstance<IngredientNodeAsset>();
            graph.idTable.composite.Add(composite);
            graph.idTable.group.Add(group);
            graph.idTable.ingredient.Add(baseIngredient);
            graph.idTable.ingredient.Add(topping);
            graph.baseEdges.Add(new NodeEdgeAssetData { from = composite, to = baseIngredient });
            graph.toppingEdges.Add(new NodeEdgeAssetData { from = composite, to = group });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = group, to = topping });

            var root = CustomerOrderTranslator.Parse("0;0;0;{c0:0.{g0:1}}", graph).customers[0].dishes[0].root;
            Assert.That(root.index, Is.EqualTo(0));
            Assert.That(root.asset, Is.SameAs(composite));
            Assert.That(root.members[0].index, Is.EqualTo(0));
            Assert.That(root.members[0].asset, Is.SameAs(baseIngredient));
            Assert.That(root.members[1].index, Is.EqualTo(0));
            Assert.That(root.members[1].asset, Is.SameAs(group));
            Assert.That(root.members[1].members[0].index, Is.EqualTo(1));
            Assert.That(root.members[1].members[0].asset, Is.SameAs(topping));
            Assert.Throws<CookingGraphFormatException>(() => CustomerOrderTranslator.Parse("0;0;0;{c1:0}", graph));

            Object.DestroyImmediate(topping);
            Object.DestroyImmediate(baseIngredient);
            Object.DestroyImmediate(group);
            Object.DestroyImmediate(composite);
            Object.DestroyImmediate(graph);
        }

        [TestCase("0;0;0;1.0")]
        [TestCase("0;0;0;{g0:1}")]
        [TestCase("0;0;0;{c0:}")]
        [TestCase("0;0;0;{c0:1")]
        [TestCase("0;0")]
        public void LegacyOrMalformedOrdersAreRejected(string source)
        {
            Assert.Throws<CookingGraphFormatException>(() => CustomerOrderTranslator.Parse(source));
        }

        [Test]
        public void GroupMinimumIsValidatedAgainstRuntimeGraph()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var composite = ScriptableObject.CreateInstance<CompositeNodeAsset>();
            var group = ScriptableObject.CreateInstance<GroupNodeAsset>();
            var ingredient = ScriptableObject.CreateInstance<IngredientNodeAsset>();
            composite.nodeName = "dish";
            group.nodeName = "toppings";
            group.minQuantity = 2;
            graph.idTable.composite.Add(composite);
            graph.idTable.group.Add(group);
            graph.idTable.ingredient.Add(ingredient);
            graph.toppingEdges.Add(new NodeEdgeAssetData { from = composite, to = group });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = group, to = ingredient });

            var issues = CustomerOrderTranslator.ValidateMinimumQuantities("0;0;0;{c0:{g0:0}}", graph);
            Assert.That(issues, Has.Count.EqualTo(1));
            Assert.That(issues[0].code, Is.EqualTo("GROUP_MINIMUM"));
            Assert.That(issues[0].minimum, Is.EqualTo(2));
            Assert.That(issues[0].actual, Is.EqualTo(1));
            Assert.Throws<CookingGraphFormatException>(() => CustomerOrderTranslator.Parse("0;0;0;{c0:{g0:0}}", graph));
            Assert.DoesNotThrow(() => CustomerOrderTranslator.Parse("0;0;0;{c0:{g0:0.0}}", graph));

            Object.DestroyImmediate(ingredient);
            Object.DestroyImmediate(group);
            Object.DestroyImmediate(composite);
            Object.DestroyImmediate(graph);
        }

        [Test]
        public void NestedGroupConsumesOneChoiceFromParentMaximum()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var composite = ScriptableObject.CreateInstance<CompositeNodeAsset>();
            var outer = ScriptableObject.CreateInstance<GroupNodeAsset>();
            var inner = ScriptableObject.CreateInstance<GroupNodeAsset>();
            var roe = ScriptableObject.CreateInstance<IngredientNodeAsset>();
            var other = ScriptableObject.CreateInstance<IngredientNodeAsset>();
            composite.nodeName = "gunkan";
            outer.nodeName = "gunkan-top";
            inner.nodeName = "single-fish-roe";
            outer.maxQuantity = new OptionalInt { hasValue = true, value = 1 };
            inner.maxQuantity = new OptionalInt { hasValue = true, value = 1 };
            graph.idTable.composite.Add(composite);
            graph.idTable.group.Add(outer);
            graph.idTable.group.Add(inner);
            graph.idTable.ingredient.Add(roe);
            graph.idTable.ingredient.Add(other);
            graph.toppingEdges.Add(new NodeEdgeAssetData { from = composite, to = outer });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = outer, to = inner });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = outer, to = other });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = inner, to = roe });

            var maximum = CustomerOrderTranslator.ValidateGroupQuantities("0;0;0;{c0:{g0:{g1:0}.1}}", graph);
            Assert.That(maximum.Any(issue => issue.code == "GROUP_MAXIMUM"), Is.True);
            var nesting = CustomerOrderTranslator.ValidateGroupQuantities("0;0;0;{c0:{g1:0}.{g0:1}}", graph);
            Assert.That(nesting.Any(issue => issue.code == "GROUP_NESTING"), Is.True);
            Assert.DoesNotThrow(() => CustomerOrderTranslator.Parse("0;0;0;{c0:{g0:{g1:0}}}", graph));
            Assert.DoesNotThrow(() => CustomerOrderTranslator.Parse("0;0;0;{c0:{g0:1}}", graph));

            Object.DestroyImmediate(other);
            Object.DestroyImmediate(roe);
            Object.DestroyImmediate(inner);
            Object.DestroyImmediate(outer);
            Object.DestroyImmediate(composite);
            Object.DestroyImmediate(graph);
        }
    }
}
