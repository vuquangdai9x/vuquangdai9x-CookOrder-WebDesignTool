using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace CookingGraph.Editor
{
    internal sealed class GraphImportResult
    {
        public GraphJsonDocument Document;
        public readonly List<string> Issues = new List<string>();
    }

    internal sealed class GraphJsonDocument
    {
        public JObject Root { get; private set; }

        public int SchemaVersion => Root.Value<int?>("schemaVersion") ?? 1;
        public JObject Map => (JObject)Root["map"];
        public JObject Vertices => (JObject)Root["vertices"];
        public JObject Edges => (JObject)Root["edges"];
        public JObject IdTable => (JObject)Root["idTable"];
        public JObject Layout => (JObject)Root["layout"];
        public JArray Notes => (JArray)Root["notes"];
        public string MapId => Map.Value<string>("id") ?? "map";
        public int VertexCount => GraphSchema.VertexKinds.Sum(kind => Array(Vertices, kind).Count);

        public GraphJsonDocument(JObject root)
        {
            Root = root ?? throw new ArgumentNullException(nameof(root));
        }

        public GraphJsonDocument Clone() => new GraphJsonDocument((JObject)Root.DeepClone());

        public string ToJson() => Root.ToString(Formatting.Indented);

        public static JArray Array(JObject owner, string name)
        {
            return owner[name] as JArray ?? throw new InvalidDataException($"Expected array '{name}'.");
        }

        public IEnumerable<(string Kind, JObject Node)> Nodes()
        {
            foreach (var kind in GraphSchema.VertexKinds)
                foreach (var token in Array(Vertices, kind).OfType<JObject>())
                    yield return (kind, token);
        }

        public IEnumerable<(string Kind, JObject Edge)> EdgeRows()
        {
            foreach (var kind in GraphSchema.EdgeKinds)
                foreach (var token in Array(Edges, kind).OfType<JObject>())
                    yield return (kind, token);
        }

        public JObject FindNode(string kind, string name)
        {
            return Array(Vertices, kind).OfType<JObject>().FirstOrDefault(node => node.Value<string>("name") == name);
        }

        public string FindKind(string nodeName)
        {
            foreach (var pair in Nodes())
                if (pair.Node.Value<string>("name") == nodeName) return pair.Kind;
            return null;
        }

        public static GraphImportResult Parse(string json)
        {
            var result = new GraphImportResult();
            JObject root;
            try
            {
                root = JToken.Parse(json) as JObject;
            }
            catch (Exception exception)
            {
                result.Issues.Add($"Not valid JSON: {exception.Message}");
                return result;
            }
            if (root == null)
            {
                result.Issues.Add("Top level is not an object.");
                return result;
            }

            NormalizeMap(root, result.Issues);
            var vertices = NormalizeBuckets(root, "vertices", GraphSchema.VertexKinds, result.Issues, true);
            var knownNames = new HashSet<string>(vertices.Properties().SelectMany(property =>
                ((JArray)property.Value).OfType<JObject>().Select(node => node.Value<string>("name"))), StringComparer.Ordinal);
            NormalizeEdges(root, knownNames, result.Issues);
            NormalizeIdTable(root, result.Issues);
            if (!(root["layout"] is JObject)) root["layout"] = new JObject();
            if (!(root["notes"] is JArray)) root["notes"] = new JArray();
            if (root["schemaVersion"]?.Type != JTokenType.Integer) root["schemaVersion"] = 1;
            result.Document = new GraphJsonDocument(root);
            return result;
        }

        private static void NormalizeMap(JObject root, ICollection<string> issues)
        {
            var map = root["map"] as JObject;
            if (map == null)
            {
                issues.Add("No 'map' block; defaults were used.");
                map = new JObject();
                root["map"] = map;
            }
            DefaultString(map, "id", "imported");
            DefaultString(map, "name", map.Value<string>("id") ?? "Imported map");
            DefaultPositive(map, "gridWidth", 4);
            DefaultPositive(map, "gridHeight", 4);
            DefaultPositive(map, "dirtyStackHeight", 3);
            DefaultPositive(map, "visibleRows", 3);
        }

        private static JObject NormalizeBuckets(JObject root, string blockName, IEnumerable<string> names, ICollection<string> issues, bool requireName)
        {
            var block = root[blockName] as JObject;
            if (block == null)
            {
                block = new JObject();
                root[blockName] = block;
            }
            foreach (var name in names)
            {
                var input = block[name] as JArray;
                if (input == null)
                {
                    if (block[name] != null) issues.Add($"{blockName}.{name} is not a list; treated as empty.");
                    block[name] = new JArray();
                    continue;
                }
                var output = new JArray();
                foreach (var row in input.OfType<JObject>())
                {
                    if (!requireName || !string.IsNullOrEmpty(row.Value<string>("name"))) output.Add(row);
                }
                if (output.Count != input.Count) issues.Add($"{blockName}.{name}: dropped {input.Count - output.Count} invalid row(s).");
                block[name] = output;
            }
            return block;
        }

        private static void NormalizeEdges(JObject root, ISet<string> knownNames, ICollection<string> issues)
        {
            var edges = NormalizeBuckets(root, "edges", GraphSchema.EdgeKinds, issues, false);
            foreach (var kind in GraphSchema.EdgeKinds)
            {
                var input = (JArray)edges[kind];
                var output = new JArray();
                foreach (var edge in input.OfType<JObject>())
                {
                    var from = edge.Value<string>("from");
                    var to = edge.Value<string>("to");
                    if (string.IsNullOrEmpty(from) || string.IsNullOrEmpty(to)) continue;
                    if (!knownNames.Contains(from) || !knownNames.Contains(to)) continue;
                    output.Add(edge);
                }
                if (output.Count != input.Count) issues.Add($"edges.{kind}: dropped {input.Count - output.Count} invalid or unresolved row(s).");
                edges[kind] = output;
            }
        }

        private static void NormalizeIdTable(JObject root, ICollection<string> issues)
        {
            var table = root["idTable"] as JObject;
            if (table == null)
            {
                issues.Add("No 'idTable' block; imported with empty id spaces.");
                table = new JObject();
                root["idTable"] = table;
            }
            foreach (var space in GraphSchema.IdSpaces)
            {
                if (!(table[space] is JArray input))
                {
                    table[space] = new JArray();
                    continue;
                }
                if (input.All(token => token.Type == JTokenType.String)) continue;
                var positions = new SortedDictionary<int, string>();
                var legacy = 0;
                var append = 0;
                foreach (var token in input)
                {
                    if (token.Type == JTokenType.String)
                    {
                        while (positions.ContainsKey(append)) append++;
                        positions[append++] = token.Value<string>() ?? string.Empty;
                    }
                    else if (token is JObject row && row.Value<int?>("id").HasValue)
                    {
                        legacy++;
                        positions[row.Value<int>("id")] = row["node"]?.Type == JTokenType.String ? row.Value<string>("node") : string.Empty;
                    }
                }
                var length = positions.Count == 0 ? 0 : positions.Keys.Max() + 1;
                var normalized = new JArray(Enumerable.Range(0, length).Select(index => positions.TryGetValue(index, out var value) ? value : string.Empty));
                table[space] = normalized;
                if (legacy > 0) issues.Add($"idTable.{space}: converted {legacy} legacy row(s) to positional names.");
            }
        }

        private static void DefaultString(JObject owner, string name, string fallback)
        {
            if (string.IsNullOrEmpty(owner.Value<string>(name))) owner[name] = fallback;
        }

        private static void DefaultPositive(JObject owner, string name, int fallback)
        {
            if ((owner.Value<int?>(name) ?? 0) <= 0) owner[name] = fallback;
        }
    }
}
