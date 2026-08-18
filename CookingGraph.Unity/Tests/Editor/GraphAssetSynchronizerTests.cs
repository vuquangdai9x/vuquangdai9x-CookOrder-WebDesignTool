using System.Linq;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;

namespace CookingGraph.Editor.Tests
{
    public sealed class GraphAssetSynchronizerTests
    {
        private const string Root = "Assets/_Production/Map-sync-test";

        [SetUp]
        public void SetUp()
        {
            AssetDatabase.DeleteAsset(Root);
        }

        [TearDown]
        public void TearDown()
        {
            AssetDatabase.DeleteAsset(Root);
        }

        [Test]
        public void GenerateThenSyncPreservesGuidAndKeepsRedundantAsset()
        {
            var first = GraphJsonDocumentTests.MinimalDocument(true);
            var initialDiff = GraphAssetSynchronizer.Compare(first);
            Assert.That(initialDiff.Missing, Has.Count.EqualTo(3));
            var graph = GraphAssetSynchronizer.Synchronize(first, "fixture.json", initialDiff);
            Assert.That(graph.ingredients, Has.Count.EqualTo(2));
            Assert.That(GraphAssetSynchronizer.HasGeneratedAssets("sync-test"), Is.True);

            var bun = graph.ingredients.Single(asset => asset.nodeName == "bun");
            var bunPath = AssetDatabase.GetAssetPath(bun);
            var bunGuid = AssetDatabase.AssetPathToGUID(bunPath);
            var extra = graph.ingredients.Single(asset => asset.nodeName == "extra");
            var extraPath = AssetDatabase.GetAssetPath(extra);

            var second = GraphJsonDocumentTests.MinimalDocument();
            second.FindNode("ingredient", "bun")["displayName"] = "Fresh Bun";
            var nextDiff = GraphAssetSynchronizer.Compare(second);
            Assert.That(nextDiff.Changed, Does.Contain("ingredient:bun"));
            Assert.That(nextDiff.Redundant, Does.Contain("ingredient:extra"));
            graph = GraphAssetSynchronizer.Synchronize(second, "fixture.json", nextDiff);

            Assert.That(graph.ingredients, Has.Count.EqualTo(1));
            Assert.That(graph.ingredients[0].displayName, Is.EqualTo("Fresh Bun"));
            Assert.That(AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(graph.ingredients[0])), Is.EqualTo(bunGuid));
            Assert.That(AssetDatabase.LoadAssetAtPath<IngredientNodeAsset>(extraPath), Is.Not.Null, "redundant file must be retained");
            var state = AssetDatabase.LoadAssetAtPath<CookingGraphEditorData>(GraphAssetSynchronizer.EditorDataPath("sync-test"));
            Assert.That(state.orphanedNodes.Any(mapping => mapping.asset == extra), Is.True);
        }

        [Test]
        public void RuntimeGraphDoesNotReferenceEditorState()
        {
            var graph = GraphAssetSynchronizer.Synchronize(GraphJsonDocumentTests.MinimalDocument(), "fixture.json", null);
            var serialized = new SerializedObject(graph);
            var iterator = serialized.GetIterator();
            while (iterator.NextVisible(true))
                if (iterator.propertyType == SerializedPropertyType.ObjectReference)
                    Assert.That(iterator.objectReferenceValue, Is.Not.TypeOf<CookingGraphEditorData>());
        }
    }
}
