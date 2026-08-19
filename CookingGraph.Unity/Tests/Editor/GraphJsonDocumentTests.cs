using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor.PackageManager;

namespace CookingGraph.Editor.Tests
{
    public sealed class GraphJsonDocumentTests
    {
        [Test]
        public void EmptyObjectIsRepairedIntoEveryBucket()
        {
            var result = GraphJsonDocument.Parse("{}");
            Assert.That(result.Document, Is.Not.Null);
            foreach (var kind in GraphSchema.VertexKinds) Assert.That(result.Document.Vertices[kind], Is.TypeOf<JArray>());
            foreach (var kind in GraphSchema.EdgeKinds) Assert.That(result.Document.Edges[kind], Is.TypeOf<JArray>());
            foreach (var space in GraphSchema.IdSpaces) Assert.That(result.Document.IdTable[space], Is.TypeOf<JArray>());
        }

        [Test]
        public void LegacyIdsNormalizePositionallyAndPreserveGaps()
        {
            var result = GraphJsonDocument.Parse(@"{
              'idTable': {'ingredient': [{'id':2,'node':'tomato'},{'id':0,'node':'bun'}]}
            }");
            Assert.That(result.Document.IdTable["ingredient"].Values<string>(), Is.EqualTo(new[] { "bun", "", "tomato" }));
            Assert.That(result.Issues.Any(issue => issue.Contains("legacy")), Is.True);
        }

        [Test]
        public void UnknownFieldsSurviveRoundTrip()
        {
            var result = GraphJsonDocument.Parse(@"{
              '_derivation':'hand', 'map':{'id':'x','name':'X'},
              'vertices':{'ingredient':[{'name':'bun','displayName':'Bun','pickupable':true,'_custom':42}]}
            }");
            var reparsed = GraphJsonDocument.Parse(result.Document.ToJson()).Document;
            Assert.That(reparsed.Root.Value<string>("_derivation"), Is.EqualTo("hand"));
            Assert.That(reparsed.FindNode("ingredient", "bun").Value<int>("_custom"), Is.EqualTo(42));
        }

        [TestCase("Graph-1-Burger.json")]
        [TestCase("Graph-2-Coffee.json")]
        public void CurrentWebFixturesParseAndReparseSemantically(string filename)
        {
            var package = PackageInfo.FindForAssembly(typeof(GraphJsonDocument).Assembly);
            var path = Path.GetFullPath(Path.Combine(package.resolvedPath, "..", "src", "data", "config", "nodegraph", "maps", filename));
            if (!File.Exists(path)) Assert.Ignore("Monorepo web fixture is unavailable outside the source checkout.");
            var first = GraphJsonDocument.Parse(File.ReadAllText(path));
            Assert.That(first.Document, Is.Not.Null);
            Assert.That(first.Document.VertexCount, Is.GreaterThan(0));
            var second = GraphJsonDocument.Parse(first.Document.ToJson());
            Assert.That(JToken.DeepEquals(first.Document.Root, second.Document.Root), Is.True);
        }

        [Test]
        public void RenameUpdatesEdgesIdsAndLayout()
        {
            var document = MinimalDocument();
            Assert.That(GraphMutation.RenameNode(document, "ingredient", "bun", "bread"), Is.True);
            Assert.That(document.IdTable["ingredient"][0].Value<string>(), Is.EqualTo("bread"));
            Assert.That(document.Edges["base"][0].Value<string>("to"), Is.EqualTo("bread"));
            Assert.That(document.Layout["ingredient:bun"], Is.Null);
            Assert.That(document.Layout["ingredient:bread"], Is.Not.Null);
        }

        internal static GraphJsonDocument MinimalDocument(bool includeExtra = false)
        {
            var extra = includeExtra ? ",{'name':'extra','displayName':'Extra','pickupable':true,'emoji':'🥬'}" : string.Empty;
            var extraId = includeExtra ? ",'extra'" : string.Empty;
            var json = @"{
              'schemaVersion':1,
              'map':{'id':'sync-test','name':'Sync Test','gridWidth':4,'gridHeight':4,'dirtyStackHeight':3,'visibleRows':3},
              'idTable':{'ingredient':['bun'" + extraId + @"],'composite':['burger'],'group':[],'tool':[],'dirty':[]},
              'vertices':{
                'ingredient':[{'name':'bun','displayName':'Bun','pickupable':true,'usageNum':1,'emoji':'🍞'}" + extra + @"],
                'tool':[],'group':[],'composite':[{'name':'burger','displayName':'Burger','orderable':true}],'dirty':[]
              },
              'edges':{'process':[],'base':[{'from':'burger','to':'bun'}],'topping':[],'option':[],'leavesDirty':[]},
              'layout':{'ingredient:bun':{'x':10,'y':20},'composite:burger':{'x':300,'y':20}},'notes':[]
            }";
            return GraphJsonDocument.Parse(json).Document;
        }
    }
}
