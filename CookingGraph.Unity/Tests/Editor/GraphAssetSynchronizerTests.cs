using System;
using System.Linq;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;

namespace CookingGraph.Editor.Tests
{
    public sealed class GraphAssetSynchronizerTests
    {
        private const string Root = "Assets/_Production/Map-sync-test";
        private const string CustomRoot = "Assets/GeneratedCooking/7-sync-test";

        [SetUp]
        public void SetUp()
        {
            AssetDatabase.DeleteAsset(Root);
            AssetDatabase.DeleteAsset(CustomRoot);
        }

        [TearDown]
        public void TearDown()
        {
            AssetDatabase.DeleteAsset(Root);
            AssetDatabase.DeleteAsset(CustomRoot);
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

        [Test]
        public void GenerationConfigFormatsMapIndexAndMapId()
        {
            var config = UnityEngine.ScriptableObject.CreateInstance<CookingGraphGenerationConfig>();
            config.mapIndex = 7;
            config.outputFolderFormat = "Assets/GeneratedCooking/{0}-{1}";

            Assert.That(GraphAssetSynchronizer.OutputRoot("sync test", config), Is.EqualTo(CustomRoot));
            var graph = GraphAssetSynchronizer.Synchronize(GraphJsonDocumentTests.MinimalDocument(), "fixture.json", null, config);
            Assert.That(AssetDatabase.GetAssetPath(graph), Does.StartWith(CustomRoot + "/"));
            var state = AssetDatabase.LoadAssetAtPath<CookingGraphEditorData>(GraphAssetSynchronizer.EditorDataPath("sync-test", config));
            Assert.That(state.mapIndex, Is.EqualTo(7));
            Assert.That(state.outputFolderFormat, Is.EqualTo(config.outputFolderFormat));
            UnityEngine.Object.DestroyImmediate(config);
        }

        [Test]
        public void GenerationConfigRejectsFoldersOutsideAssets()
        {
            var config = UnityEngine.ScriptableObject.CreateInstance<CookingGraphGenerationConfig>();
            config.outputFolderFormat = "../Generated/{1}";
            Assert.Throws<InvalidOperationException>(() => GraphAssetSynchronizer.OutputRoot("sync-test", config));
            UnityEngine.Object.DestroyImmediate(config);
        }

        [Test]
        public void WebImageUrlDoesNotMarkRuntimeAssetsChanged()
        {
            var first = GraphJsonDocumentTests.MinimalDocument();
            first.FindNode("ingredient", "bun")["imageURL"] = "https://example.com/one.png";
            GraphAssetSynchronizer.Synchronize(first, "fixture.json", null);

            var second = GraphJsonDocumentTests.MinimalDocument();
            second.FindNode("ingredient", "bun")["imageURL"] = "https://example.com/two.png";
            var diff = GraphAssetSynchronizer.Compare(second);

            Assert.That(diff.Changed, Does.Not.Contain("ingredient:bun"));
            Assert.That(diff.Unchanged, Does.Contain("ingredient:bun"));
        }

        [Test]
        public void DirtyNodeMaxStackIsGeneratedAsOptionalRuntimeData()
        {
            var document = GraphJsonDocumentTests.MinimalDocument();
            document.Vertices["dirty"].Add(new JObject
            {
                ["name"] = "dirty-plate",
                ["displayName"] = "Dirty Plate",
                ["maxStack"] = 2
            });
            document.IdTable["dirty"] = new JArray("dirty-plate");

            var graph = GraphAssetSynchronizer.Synchronize(document, "fixture.json", null);
            var dirty = graph.dirtyObjects.Single();
            Assert.That(dirty.maxStack.hasValue, Is.True);
            Assert.That(dirty.maxStack.value, Is.EqualTo(2));
        }
    }
}
