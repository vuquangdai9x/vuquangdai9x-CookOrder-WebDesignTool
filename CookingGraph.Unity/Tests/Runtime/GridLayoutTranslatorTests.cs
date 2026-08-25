using NUnit.Framework;
using UnityEngine;

namespace CookingGraph.Tests
{
    public sealed class GridLayoutTranslatorTests
    {
        [Test]
        public void CanonicalGridRoundTripsWithCellEffects()
        {
            const string source = ",,#4:1:1,,,,,#3#2:1,,";
            var data = GridLayoutTranslator.Parse(source);

            Assert.That(data.cells, Has.Count.EqualTo(10));
            Assert.That(data.cells[0].IsBlank, Is.True);
            Assert.That(data.cells[2].effects[0].effectId, Is.EqualTo((int)CellStatusId.ColorLock));
            Assert.That(data.cells[2].effects[0].parameters, Is.EqualTo(new[] { 1, 1 }));
            Assert.That(data.cells[7].effects, Has.Count.EqualTo(2));
            Assert.That(data.cells[7].Has(CellStatusId.IngredientSlot), Is.True);
            Assert.That(data.cells[7].Has(CellStatusId.OrderLock), Is.True);
            Assert.That(data.cells[7].effects[1].parameters, Is.EqualTo(new[] { 1 }));
            Assert.That(GridLayoutTranslator.Serialize(data), Is.EqualTo(source));
        }

        [Test]
        public void AllBlankGridRoundTrips()
        {
            const string source = ",,,,,,,,,";
            var data = GridLayoutTranslator.Parse(source);
            Assert.That(data.cells, Has.Count.EqualTo(10));
            Assert.That(data.cells.TrueForAll(cell => cell.IsBlank), Is.True);
            Assert.That(GridLayoutTranslator.Serialize(data), Is.EqualTo(source));
        }

        [Test]
        public void EmptyStringIsOneBlankCell()
        {
            // Matches the web parser: a blank single cell serializes back to "", so reading it as
            // zero cells would break the round trip.
            var data = GridLayoutTranslator.Parse(string.Empty);
            Assert.That(data.cells, Has.Count.EqualTo(1));
            Assert.That(GridLayoutTranslator.Serialize(data), Is.Empty);
        }

        [Test]
        public void SyntaxOnlyParseLeavesDimensionsUnknown()
        {
            var data = GridLayoutTranslator.Parse(",,,");
            Assert.That(data.HasDimensions, Is.False);
            Assert.That(data.IndexOf(0, 0), Is.EqualTo(-1));
            Assert.That(data.CellAt(0, 0), Is.Null);
        }

        [TestCase("0,,")]
        [TestCase(",x,")]
        [TestCase(",#,")]
        [TestCase(",#a,")]
        public void MalformedCellsAreRejected(string source)
        {
            Assert.Throws<CookingGraphFormatException>(() => GridLayoutTranslator.Parse(source));
        }

        [Test]
        public void TryParseReturnsStructuredError()
        {
            Assert.That(GridLayoutTranslator.TryParse(",,bad", out var data, out var error), Is.False);
            Assert.That(data, Is.Null);
            Assert.That(error, Is.Not.Null);
            Assert.That(error.Position, Is.GreaterThanOrEqualTo(0));
        }

        [Test]
        public void GraphAwareParseAppliesMapDimensionsInScanOrder()
        {
            var graph = Graph(5, 2);
            var data = GridLayoutTranslator.Parse(",,,,,,,#1,,", graph);

            Assert.That(data.HasDimensions, Is.True);
            Assert.That(data.width, Is.EqualTo(5));
            Assert.That(data.height, Is.EqualTo(2));
            // Index 7 of a 5-wide grid is the second row, third column.
            Assert.That(data.IndexOf(2, 1), Is.EqualTo(7));
            Assert.That(data.CellAt(2, 1).Has(CellStatusId.Blocked), Is.True);
            Assert.That(data.CellAt(0, 0).IsBlank, Is.True);
            Assert.That(data.CellAt(5, 0), Is.Null, "off the grid");

            Object.DestroyImmediate(graph);
        }

        [Test]
        public void GraphAwareParseRejectsAGridThatIsNotMapSized()
        {
            var graph = Graph(5, 2);
            // Nine cells where the map wants ten: every later cell would silently shift.
            Assert.Throws<CookingGraphFormatException>(() => GridLayoutTranslator.Parse(",,,,,,,,", graph));
            Object.DestroyImmediate(graph);
        }

        [Test]
        public void IngredientSlotResolvesThroughTheIdTable()
        {
            var graph = Graph(2, 1);
            var bun = ScriptableObject.CreateInstance<IngredientNodeAsset>();
            graph.idTable.ingredient.Add(bun);

            var data = GridLayoutTranslator.Parse("#3:0:2,", graph);
            Assert.That(GridLayoutTranslator.TryGetIngredientSlot(data.cells[0].effects[0], graph, out var ingredient, out var amount), Is.True);
            Assert.That(ingredient, Is.SameAs(bun));
            Assert.That(amount, Is.EqualTo(2));

            // Only the ingredient-slot effect names a node; a colour lock's first param is a key
            // colour, which is not in the graph at all.
            var colorLock = GridLayoutTranslator.Parse("#4:0:1,", graph);
            Assert.That(GridLayoutTranslator.TryGetIngredientSlot(colorLock.cells[0].effects[0], graph, out _, out _), Is.False);

            Assert.Throws<CookingGraphFormatException>(() => GridLayoutTranslator.Parse("#3:9:1,", graph));

            Object.DestroyImmediate(bun);
            Object.DestroyImmediate(graph);
        }

        [Test]
        public void BlankBuildsAMapSizedGrid()
        {
            var graph = Graph(5, 2);
            var blank = GridLayoutTranslator.Blank(graph);

            Assert.That(blank, Is.EqualTo(",,,,,,,,,"));
            Assert.That(GridLayoutTranslator.Parse(blank, graph).cells, Has.Count.EqualTo(10));

            Object.DestroyImmediate(graph);
        }

        private static CookingGraphAsset Graph(int width, int height)
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            graph.map = new CookingMapData { id = "test", name = "Test", gridWidth = width, gridHeight = height };
            return graph;
        }
    }
}
