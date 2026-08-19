using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace CookingGraph
{
    public static class IngredientQueueTranslator
    {
        public static IngredientQueueData Parse(string source)
        {
            if (source == null)
                throw new CookingGraphFormatException("Queue string is null", 0, string.Empty);

            var sections = source.Split(new[] { '$' }, StringSplitOptions.None);
            if (sections.Length > 3)
                throw new CookingGraphFormatException("Queue string has more than two group sections", source.IndexOf('$'), source);

            var result = new IngredientQueueData();
            var queueSection = sections.Length > 0 ? sections[0] : string.Empty;
            if (!string.IsNullOrWhiteSpace(queueSection))
            {
                foreach (var columnToken in queueSection.Split(new[] { '%' }, StringSplitOptions.None))
                {
                    var column = new IngredientQueueColumnData();
                    foreach (var itemToken in columnToken.Split(new[] { ',' }, StringSplitOptions.None))
                    {
                        var parsed = ParseEffectToken(itemToken, source);
                        var id = ParseInteger(parsed.Base, source, source.IndexOf(itemToken, StringComparison.Ordinal));
                        column.items.Add(new QueueItemData
                        {
                            id = id,
                            index = id < 0 ? -1 : id,
                            kind = id < 0 ? QueueItemKind.Sweeper : QueueItemKind.Ingredient,
                            effects = parsed.Effects
                        });
                    }
                    result.columns.Add(column);
                }
            }

            if (sections.Length > 1)
                result.groups.AddRange(ParseGroups(sections[1], QueueGroupKind.Combined, source));
            if (sections.Length > 2)
                result.groups.AddRange(ParseGroups(sections[2], QueueGroupKind.Linked, source));
            return result;
        }

        /// <summary>Parses a queue and resolves every ingredient index to its generated node asset.</summary>
        public static IngredientQueueData Parse(string source, CookingGraphAsset graph)
        {
            if (graph == null) throw new ArgumentNullException(nameof(graph));
            var data = Parse(source);
            foreach (var item in data.columns.SelectMany(column => column.items))
            {
                if (item.kind == QueueItemKind.Sweeper)
                {
                    item.index = -1;
                    item.ingredient = null;
                    continue;
                }
                item.index = item.id;
                if (item.index < 0 || item.index >= graph.idTable.ingredient.Count || graph.idTable.ingredient[item.index] == null)
                {
                    var token = item.id.ToString(CultureInfo.InvariantCulture);
                    throw new CookingGraphFormatException(
                        $"Ingredient index {item.index} does not resolve to an IngredientNodeAsset",
                        Math.Max(0, source.IndexOf(token, StringComparison.Ordinal)),
                        source);
                }
                item.ingredient = graph.idTable.ingredient[item.index];
            }
            return data;
        }

        public static bool TryParse(string source, out IngredientQueueData data, out CookingGraphFormatException error)
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

        public static bool TryParse(string source, CookingGraphAsset graph, out IngredientQueueData data, out CookingGraphFormatException error)
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

        public static string Serialize(IngredientQueueData data)
        {
            if (data == null) throw new ArgumentNullException(nameof(data));
            var queue = string.Join("%", data.columns.Select(column =>
                string.Join(",", column.items.Select(item => item.id.ToString(CultureInfo.InvariantCulture) + SerializeEffects(item.effects)))));
            if (data.groups == null || data.groups.Count == 0) return queue;
            return queue + "$" + SerializeGroups(data.groups, QueueGroupKind.Combined) + "$" + SerializeGroups(data.groups, QueueGroupKind.Linked);
        }

        internal static (string Base, List<EffectData> Effects) ParseEffectToken(string token, string context)
        {
            var parts = token.Split(new[] { '#' }, StringSplitOptions.None);
            var effects = new List<EffectData>();
            for (var i = 1; i < parts.Length; i++)
            {
                var values = parts[i].Split(new[] { ':' }, StringSplitOptions.None);
                if (values.Length == 0 || values[0].Length == 0)
                    throw new CookingGraphFormatException("Effect id is empty", Math.Max(0, context.IndexOf(token, StringComparison.Ordinal)), context);
                var effect = new EffectData
                {
                    effectId = ParseInteger(values[0], context, Math.Max(0, context.IndexOf(values[0], StringComparison.Ordinal)))
                };
                for (var p = 1; p < values.Length; p++)
                    effect.parameters.Add(ParseInteger(values[p], context, Math.Max(0, context.IndexOf(values[p], StringComparison.Ordinal))));
                effects.Add(effect);
            }
            return (parts[0], effects);
        }

        internal static string SerializeEffects(IReadOnlyList<EffectData> effects)
        {
            if (effects == null) return string.Empty;
            return string.Concat(effects.Select(effect =>
                "#" + string.Join(":", new[] { effect.effectId }.Concat(effect.parameters ?? new List<int>())
                    .Select(value => value.ToString(CultureInfo.InvariantCulture)))));
        }

        internal static int ParseInteger(string token, string context, int position)
        {
            if (string.IsNullOrEmpty(token) || !int.TryParse(token, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var value))
                throw new CookingGraphFormatException($"Invalid integer \"{token}\"", Math.Max(0, position), context);
            return value;
        }

        private static IEnumerable<QueueGroupData> ParseGroups(string section, QueueGroupKind kind, string context)
        {
            if (string.IsNullOrWhiteSpace(section)) yield break;
            foreach (var groupToken in section.Split(new[] { ';' }, StringSplitOptions.None))
            {
                var group = new QueueGroupData { kind = kind };
                foreach (var cellToken in groupToken.Split(new[] { ',' }, StringSplitOptions.None))
                {
                    var pair = cellToken.Split(new[] { '-' }, StringSplitOptions.None);
                    if (pair.Length != 2 || pair[0].Length == 0 || pair[1].Length == 0)
                        throw new CookingGraphFormatException($"Invalid queue-group cell \"{cellToken}\"; expected <x>-<y>", Math.Max(0, context.IndexOf(cellToken, StringComparison.Ordinal)), context);
                    var x = ParseInteger(pair[0], context, Math.Max(0, context.IndexOf(cellToken, StringComparison.Ordinal)));
                    var y = ParseInteger(pair[1], context, Math.Max(0, context.IndexOf(cellToken, StringComparison.Ordinal)));
                    if (x < 0 || y < 0)
                        throw new CookingGraphFormatException("Queue-group coordinates must be non-negative", Math.Max(0, context.IndexOf(cellToken, StringComparison.Ordinal)), context);
                    group.cells.Add(new QueueCellData { x = x, y = y });
                }
                yield return group;
            }
        }

        private static string SerializeGroups(IEnumerable<QueueGroupData> groups, QueueGroupKind kind)
        {
            return string.Join(";", groups.Where(group => group.kind == kind).Select(group =>
                string.Join(",", group.cells.Select(cell => $"{cell.x.ToString(CultureInfo.InvariantCulture)}-{cell.y.ToString(CultureInfo.InvariantCulture)}"))));
        }
    }
}
