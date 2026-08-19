using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;
using UnityEngine;

namespace CookingGraph.Tests
{
    public sealed class GeneratorTests
    {
        [Test]
        public void CustomerGeneratorHonorsNestedParentMaximumAndReturnsResolvedMembers()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var dish = Node<CompositeNodeAsset>("gunkan");
            dish.orderable = true;
            dish.toppingRequired = true;
            var baseIngredient = Node<IngredientNodeAsset>("rice");
            var roe = Node<IngredientNodeAsset>("roe");
            var other = Node<IngredientNodeAsset>("other");
            var outer = Node<GroupNodeAsset>("gunkan-top");
            var inner = Node<GroupNodeAsset>("single-fish-roe");
            outer.maxQuantity = Optional(1);
            inner.maxQuantity = Optional(1);
            graph.ingredients.AddRange(new[] { baseIngredient, roe, other });
            graph.groups.AddRange(new[] { outer, inner });
            graph.composites.Add(dish);
            graph.idTable.ingredient.AddRange(new[] { baseIngredient, roe, other });
            graph.idTable.group.AddRange(new[] { outer, inner });
            graph.idTable.composite.Add(dish);
            graph.baseEdges.Add(new NodeEdgeAssetData { from = dish, to = baseIngredient });
            graph.toppingEdges.Add(new NodeEdgeAssetData { from = dish, to = outer });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = outer, to = inner });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = outer, to = other });
            graph.optionEdges.Add(new OptionEdgeAssetData { from = inner, to = roe });

            var options = new CustomerOrderGenerationOptions
            {
                dishCounts = new List<int> { 1 },
                curve = ConstantCurve(3),
                weights = graph.ingredients.Select((ingredient, index) => new IngredientGenerationWeight
                {
                    ingredient = ingredient,
                    index = index,
                    weight = 100
                }).ToList()
            };
            var generated = CustomerOrderGenerator.Generate(graph, options, () => 0);
            var root = generated.customers.Single().dishes.Single().root;
            var outerMember = root.members.Single(member => member.asset == outer);

            Assert.That(root.asset, Is.SameAs(dish));
            Assert.That(root.index, Is.EqualTo(0));
            Assert.That(outerMember.members, Has.Count.EqualTo(1), "The nested group consumes the outer group's only choice.");
            Assert.That(outerMember.members[0].asset, Is.SameAs(inner));
            Assert.That(outerMember.members[0].members.Single().asset, Is.SameAs(roe));
            Assert.That(CustomerOrderTranslator.Serialize(generated), Is.EqualTo("0;0;0;{c0:0.{g0:{g1:1}}}"));

            Destroy(graph, dish, baseIngredient, roe, other, outer, inner);
        }

        [Test]
        public void QueueGeneratorWalksAllProcessInputsAndReturnsResolvedItems()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var raw = Node<IngredientNodeAsset>("raw");
            raw.pickupable = true;
            var cup = Node<IngredientNodeAsset>("cup");
            cup.pickupable = true;
            var cooked = Node<IngredientNodeAsset>("cooked");
            cooked.usageNum = 2;
            var tool = Node<ToolNodeAsset>("tool");
            graph.ingredients.AddRange(new[] { raw, cup, cooked });
            graph.tools.Add(tool);
            graph.idTable.ingredient.AddRange(new[] { raw, cup, cooked });
            graph.processEdges.Add(new ProcessEdgeAssetData
            {
                from = tool,
                to = cooked,
                amount = 1,
                inputs = new List<ProcessInputAssetData>
                {
                    new ProcessInputAssetData { ingredient = raw, slot = 0 },
                    new ProcessInputAssetData { ingredient = cup, slot = 1 }
                }
            });
            var customers = new CustomerOrderData
            {
                customers = new List<CustomerData>
                {
                    new CustomerData
                    {
                        dishes = new List<DishOrderData>
                        {
                            new DishOrderData { root = WrapperWith(cooked, 2) },
                            new DishOrderData { root = WrapperWith(cooked, 2) }
                        }
                    }
                }
            };

            var queue = IngredientQueueGenerator.Generate(graph, customers, 2, new QueueShuffleRange(), () => 0);
            Assert.That(queue.columns, Has.Count.EqualTo(2));
            Assert.That(queue.columns.SelectMany(column => column.items).Select(item => item.ingredient), Is.EquivalentTo(new[] { raw, cup }));
            Assert.That(queue.columns.SelectMany(column => column.items).All(item => item.index == item.id && item.ingredient != null), Is.True);
            Assert.That(IngredientQueueTranslator.Serialize(queue), Is.EqualTo("0%1"));

            Destroy(graph, raw, cup, cooked, tool);
        }

        private static OrderMemberData WrapperWith(IngredientNodeAsset ingredient, int id)
        {
            var root = new OrderMemberData { kind = OrderMemberKind.Composite, id = 0, index = 0 };
            root.members.Add(new OrderMemberData { kind = OrderMemberKind.Ingredient, id = id, index = id, asset = ingredient });
            return root;
        }

        private static T Node<T>(string name) where T : CookingNodeAsset
        {
            var value = ScriptableObject.CreateInstance<T>();
            value.nodeName = name;
            value.displayName = name;
            return value;
        }

        private static OptionalInt Optional(int value) => new OptionalInt { hasValue = true, value = value };

        private static GenerationCurve ConstantCurve(float value)
        {
            return new GenerationCurve
            {
                range = new GenerationCurveRange { minX = 0, maxX = 1, minY = value, maxY = value },
                keyframes = new List<GenerationCurveKeyframe>
                {
                    new GenerationCurveKeyframe { x = 0, y = 0.5f },
                    new GenerationCurveKeyframe { x = 1, y = 0.5f }
                }
            };
        }

        private static void Destroy(params Object[] values)
        {
            foreach (var value in values) Object.DestroyImmediate(value);
        }
    }
}
