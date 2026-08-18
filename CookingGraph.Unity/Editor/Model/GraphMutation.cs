using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace CookingGraph.Editor
{
    internal static class GraphMutation
    {
        public static JObject AddNode(GraphJsonDocument document, string kind)
        {
            var definition = GraphSchema.Vertices[kind];
            var used = new HashSet<string>(document.Nodes().Select(pair => pair.Node.Value<string>("name")), StringComparer.Ordinal);
            var baseName = kind;
            var name = baseName;
            for (var suffix = 2; used.Contains(name); suffix++) name = baseName + "-" + suffix;
            var node = new JObject();
            foreach (var field in definition.Fields)
            {
                if (field.Name == "name") node[field.Name] = name;
                else if (field.Name == "displayName") node[field.Name] = definition.Label;
                else if (field.Required || field.DefaultValue != null) node[field.Name] = field.DefaultValue != null ? JToken.FromObject(field.DefaultValue) : DefaultToken(field.Type);
            }
            if (kind == "tool" && (!(node["slotConfigs"] is JArray slots) || slots.Count == 0))
                node["slotConfigs"] = new JArray(new JObject { ["name"] = "Input", ["slot"] = 1 });
            GraphJsonDocument.Array(document.Vertices, kind).Add(node);
            document.Layout[$"{kind}:{name}"] = new JObject { ["x"] = 40, ["y"] = 40 };
            return node;
        }

        public static JObject DuplicateNode(GraphJsonDocument document, string kind, string name)
        {
            var source = document.FindNode(kind, name);
            if (source == null) return null;
            var names = new HashSet<string>(document.Nodes().Select(pair => pair.Node.Value<string>("name")), StringComparer.Ordinal);
            var next = name + "-copy";
            for (var suffix = 2; names.Contains(next); suffix++) next = name + "-copy-" + suffix;
            var clone = (JObject)source.DeepClone();
            clone["name"] = next;
            GraphJsonDocument.Array(document.Vertices, kind).Add(clone);
            var sourceLayout = document.Layout[$"{kind}:{name}"] as JObject;
            document.Layout[$"{kind}:{next}"] = new JObject
            {
                ["x"] = (sourceLayout?.Value<float?>("x") ?? 40) + 24,
                ["y"] = (sourceLayout?.Value<float?>("y") ?? 40) + 24
            };
            return clone;
        }

        public static bool RenameNode(GraphJsonDocument document, string kind, string oldName, string newName)
        {
            if (string.IsNullOrWhiteSpace(newName) || document.Nodes().Any(pair => pair.Node.Value<string>("name") == newName)) return false;
            var node = document.FindNode(kind, oldName);
            if (node == null) return false;
            node["name"] = newName;
            foreach (var pair in document.EdgeRows())
            {
                if (pair.Edge.Value<string>("from") == oldName) pair.Edge["from"] = newName;
                if (pair.Edge.Value<string>("to") == oldName) pair.Edge["to"] = newName;
                if (pair.Kind != "process") continue;
                foreach (var input in (pair.Edge["inputs"] as JArray ?? new JArray()).OfType<JObject>())
                    if (input.Value<string>("ingredient") == oldName) input["ingredient"] = newName;
                if (pair.Edge["chainTools"] is JArray chain)
                    foreach (var token in chain.Where(token => token.Value<string>() == oldName).ToList()) token.Replace(newName);
            }
            foreach (var space in GraphSchema.IdSpaces)
            {
                foreach (var token in GraphJsonDocument.Array(document.IdTable, space).Where(token => token.Value<string>() == oldName).ToList())
                    token.Replace(newName);
            }
            var oldKey = $"{kind}:{oldName}";
            if (document.Layout[oldKey] != null)
            {
                document.Layout[$"{kind}:{newName}"] = document.Layout[oldKey];
                document.Layout.Remove(oldKey);
            }
            return true;
        }

        public static bool DeleteNode(GraphJsonDocument document, string kind, string name)
        {
            var nodes = GraphJsonDocument.Array(document.Vertices, kind);
            var node = nodes.OfType<JObject>().FirstOrDefault(value => value.Value<string>("name") == name);
            if (node == null) return false;
            node.Remove();
            foreach (var edgeKind in GraphSchema.EdgeKinds)
            {
                foreach (var edge in GraphJsonDocument.Array(document.Edges, edgeKind).OfType<JObject>()
                             .Where(value => value.Value<string>("from") == name || value.Value<string>("to") == name).ToList())
                    edge.Remove();
            }
            foreach (var process in GraphJsonDocument.Array(document.Edges, "process").OfType<JObject>())
            {
                if (process["inputs"] is JArray inputs)
                    foreach (var input in inputs.OfType<JObject>().Where(value => value.Value<string>("ingredient") == name).ToList()) input.Remove();
                if (process["chainTools"] is JArray chain)
                    foreach (var token in chain.Where(value => value.Value<string>() == name).ToList()) token.Remove();
            }
            foreach (var space in GraphSchema.IdSpaces)
            {
                var rows = GraphJsonDocument.Array(document.IdTable, space);
                var index = rows.Select((token, at) => (token, at)).FirstOrDefault(pair => pair.token.Value<string>() == name).at;
                if (index >= 0 && index < rows.Count && rows[index].Value<string>() == name) rows.RemoveAt(index);
            }
            document.Layout.Remove($"{kind}:{name}");
            return true;
        }

        public static JObject AddEdge(GraphJsonDocument document, string kind, string from, string to)
        {
            var edge = new JObject { ["from"] = from, ["to"] = to };
            if (kind == "process")
            {
                edge["inputs"] = new JArray();
                edge["amount"] = 1;
            }
            if (kind == "option") edge["maxQuantity"] = -1;
            GraphJsonDocument.Array(document.Edges, kind).Add(edge);
            return edge;
        }

        public static void MoveId(GraphJsonDocument document, string space, int from, int to)
        {
            var rows = GraphJsonDocument.Array(document.IdTable, space);
            if (from < 0 || to < 0 || from >= rows.Count || to >= rows.Count || from == to) return;
            var value = rows[from];
            value.Remove();
            rows.Insert(to, value);
        }

        private static JToken DefaultToken(string type)
        {
            if (type.EndsWith("[]", StringComparison.Ordinal)) return new JArray();
            if (type == "bool") return false;
            if (type == "int" || type == "number") return 0;
            return string.Empty;
        }
    }
}
