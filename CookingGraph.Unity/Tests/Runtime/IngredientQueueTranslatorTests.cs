using NUnit.Framework;
using UnityEngine;

namespace CookingGraph.Tests
{
    public sealed class IngredientQueueTranslatorTests
    {
        [Test]
        public void CanonicalQueueRoundTripsWithEffects()
        {
            const string source = "0,1#4:5,0,1%0,0,1,0%1,7,1,7,7";
            var data = IngredientQueueTranslator.Parse(source);
            Assert.That(data.columns, Has.Count.EqualTo(3));
            Assert.That(data.columns[0].items[1].effects[0].effectId, Is.EqualTo(4));
            Assert.That(data.columns[0].items[1].effects[0].parameters, Is.EqualTo(new[] { 5 }));
            Assert.That(IngredientQueueTranslator.Serialize(data), Is.EqualTo(source));
        }

        [Test]
        public void GroupsAndSweeperRoundTrip()
        {
            const string source = "-1,1,0%0,0,1%1,7,1$0-0,1-0;0-1,0-2$1-1,2-1";
            var data = IngredientQueueTranslator.Parse(source);
            Assert.That(data.columns[0].items[0].kind, Is.EqualTo(QueueItemKind.Sweeper));
            Assert.That(data.groups, Has.Count.EqualTo(3));
            Assert.That(data.groups[0].kind, Is.EqualTo(QueueGroupKind.Combined));
            Assert.That(data.groups[2].kind, Is.EqualTo(QueueGroupKind.Linked));
            Assert.That(IngredientQueueTranslator.Serialize(data), Is.EqualTo(source));
        }

        [Test]
        public void GroupLessQueueDoesNotGainTrailer()
        {
            const string source = "5#2#1:3,0";
            Assert.That(IngredientQueueTranslator.Serialize(IngredientQueueTranslator.Parse(source)), Is.EqualTo(source));
        }

        [TestCase("0,1$-1-2$")]
        [TestCase("0,1$1-2-3$")]
        [TestCase("0,1$1-$")]
        [TestCase("0,1$$$extra")]
        public void MalformedGroupsAreRejected(string source)
        {
            Assert.Throws<CookingGraphFormatException>(() => IngredientQueueTranslator.Parse(source));
        }

        [Test]
        public void TryParseReturnsStructuredError()
        {
            Assert.That(IngredientQueueTranslator.TryParse("x", out var data, out var error), Is.False);
            Assert.That(data, Is.Null);
            Assert.That(error, Is.Not.Null);
            Assert.That(error.Position, Is.GreaterThanOrEqualTo(0));
        }

        [Test]
        public void GraphAwareParseResolvesIngredientAssetAndIndex()
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            var first = ScriptableObject.CreateInstance<IngredientNodeAsset>();
            var second = ScriptableObject.CreateInstance<IngredientNodeAsset>();
            graph.idTable.ingredient.Add(first);
            graph.idTable.ingredient.Add(second);

            var data = IngredientQueueTranslator.Parse("1,-1", graph);
            Assert.That(data.columns[0].items[0].id, Is.EqualTo(1));
            Assert.That(data.columns[0].items[0].index, Is.EqualTo(1));
            Assert.That(data.columns[0].items[0].ingredient, Is.SameAs(second));
            Assert.That(data.columns[0].items[1].index, Is.EqualTo(-1));
            Assert.That(data.columns[0].items[1].ingredient, Is.Null);
            Assert.Throws<CookingGraphFormatException>(() => IngredientQueueTranslator.Parse("2", graph));

            Object.DestroyImmediate(second);
            Object.DestroyImmediate(first);
            Object.DestroyImmediate(graph);
        }
    }
}
