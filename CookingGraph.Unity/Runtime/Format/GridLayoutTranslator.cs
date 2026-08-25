using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace CookingGraph
{
    /// <summary>
    /// The prep-grid string: <c>,,#4:1:1,,,,,#3#2:1,,</c>
    ///
    /// A comma separates cells in scan order (left to right, top to bottom); an empty entry is a
    /// blank cell, and any other entry is a cell-type/effect list using the same <c>#id:param</c>
    /// grammar the queue and customer formats use. The string carries no dimensions of its own —
    /// they come from the map header, which is why the graph overload is the one that can check the
    /// cell count and fill in width/height.
    ///
    /// Mirrors <c>parseGrid</c> / <c>serializeGrid</c> in the web tool's <c>core/parser.ts</c>.
    /// See GAMEPLAY_RULES.md §4.2.
    /// </summary>
    public static class GridLayoutTranslator
    {
        /// <summary>
        /// Syntax-only parse; width and height stay -1. An empty string is one blank cell, not zero
        /// cells — that is what makes <c>Serialize(Parse(s)) == s</c> hold for every canonical
        /// string, and it matches the web parser exactly.
        /// </summary>
        public static GridLayoutData Parse(string source)
        {
            if (source == null)
                throw new CookingGraphFormatException("Grid string is null", 0, string.Empty);

            var result = new GridLayoutData();
            var position = 0;
            foreach (var cellToken in source.Split(new[] { ',' }, StringSplitOptions.None))
            {
                var cell = new GridCellData();
                if (cellToken.Length > 0)
                {
                    if (cellToken[0] != '#')
                        throw new CookingGraphFormatException(
                            $"Invalid grid cell \"{cellToken}\"; expected an empty entry or \"#effect\"", position, source);
                    cell.effects = IngredientQueueTranslator.ParseEffectToken(cellToken, source).Effects;
                }
                result.cells.Add(cell);
                position += cellToken.Length + 1;
            }
            return result;
        }

        /// <summary>
        /// Parses against a map: the cell count must be exactly <c>gridWidth * gridHeight</c>, and
        /// every cell effect that names a node must resolve. A grid whose length disagrees with the
        /// map silently shifts every later cell, so it is rejected rather than padded.
        /// </summary>
        public static GridLayoutData Parse(string source, CookingGraphAsset graph)
        {
            if (graph == null) throw new ArgumentNullException(nameof(graph));
            var data = Parse(source);
            var width = graph.map?.gridWidth ?? 0;
            var height = graph.map?.gridHeight ?? 0;
            if (width <= 0 || height <= 0)
                throw new CookingGraphFormatException($"Map '{graph.map?.id}' has no usable grid size ({width}x{height})", 0, source);

            var expected = width * height;
            if (data.cells.Count != expected)
                throw new CookingGraphFormatException(
                    $"Grid has {data.cells.Count} cell(s) but map '{graph.map.id}' is {width}x{height} ({expected})", 0, source);

            for (var index = 0; index < data.cells.Count; index++)
                foreach (var effect in data.cells[index].effects.Where(effect => effect.effectId == (int)CellStatusId.IngredientSlot))
                    ResolveIngredientSlot(effect, graph, source, index);

            data.width = width;
            data.height = height;
            return data;
        }

        public static bool TryParse(string source, out GridLayoutData data, out CookingGraphFormatException error)
        {
            try
            {
                data = Parse(source);
                error = null;
                return true;
            }
            catch (CookingGraphFormatException exception)
            {
                data = null;
                error = exception;
                return false;
            }
        }

        public static bool TryParse(string source, CookingGraphAsset graph, out GridLayoutData data, out CookingGraphFormatException error)
        {
            try
            {
                data = Parse(source, graph);
                error = null;
                return true;
            }
            catch (CookingGraphFormatException exception)
            {
                data = null;
                error = exception;
                return false;
            }
        }

        public static string Serialize(GridLayoutData data)
        {
            if (data == null) throw new ArgumentNullException(nameof(data));
            return string.Join(",", data.cells.Select(cell =>
                IngredientQueueTranslator.SerializeEffects(cell == null ? null : cell.effects)));
        }

        /// <summary>
        /// Builds a grid string of blank cells for a map — the starting point for a new level.
        /// </summary>
        public static string Blank(CookingGraphAsset graph)
        {
            if (graph == null) throw new ArgumentNullException(nameof(graph));
            var count = Math.Max(0, (graph.map?.gridWidth ?? 0) * (graph.map?.gridHeight ?? 0));
            return count == 0 ? string.Empty : new string(',', count - 1);
        }

        /// <summary>
        /// Reads an Ingredient-slot effect: the cell opens once <paramref name="amount"/> pickups of
        /// <paramref name="ingredient"/> have happened. It is the only cell effect whose parameters
        /// name a node — OrderLock counts customers and ColorLock names a key colour, neither of
        /// which lives in the graph. Returns false for any other effect.
        /// </summary>
        public static bool TryGetIngredientSlot(EffectData effect, CookingGraphAsset graph, out IngredientNodeAsset ingredient, out int amount)
        {
            ingredient = null;
            amount = 0;
            if (effect == null || graph == null || effect.effectId != (int)CellStatusId.IngredientSlot) return false;
            var index = effect.parameters != null && effect.parameters.Count > 0 ? effect.parameters[0] : 0;
            if (index < 0 || index >= graph.idTable.ingredient.Count) return false;
            ingredient = graph.idTable.ingredient[index];
            amount = effect.parameters != null && effect.parameters.Count > 1 ? effect.parameters[1] : 1;
            return ingredient != null;
        }

        private static void ResolveIngredientSlot(EffectData effect, CookingGraphAsset graph, string source, int cellIndex)
        {
            var index = effect.parameters != null && effect.parameters.Count > 0 ? effect.parameters[0] : 0;
            if (index < 0 || index >= graph.idTable.ingredient.Count || graph.idTable.ingredient[index] == null)
                throw new CookingGraphFormatException(
                    $"Cell {cellIndex.ToString(CultureInfo.InvariantCulture)} keys an ingredient slot to index {index.ToString(CultureInfo.InvariantCulture)}, which does not resolve to an IngredientNodeAsset",
                    0,
                    source);
        }
    }
}
