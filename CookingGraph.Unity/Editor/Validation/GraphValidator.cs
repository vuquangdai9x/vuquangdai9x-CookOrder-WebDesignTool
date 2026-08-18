using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace CookingGraph.Editor
{
    internal enum GraphIssueSeverity
    {
        Warning,
        Error
    }

    internal sealed class GraphIssue
    {
        public GraphIssueSeverity Severity { get; }
        public string Code { get; }
        public string Message { get; }
        public string NodeName { get; }

        public GraphIssue(GraphIssueSeverity severity, string code, string message, string nodeName = null)
        {
            Severity = severity;
            Code = code;
            Message = message;
            NodeName = nodeName;
        }

        public override string ToString() => $"{Code}: {Message}";
    }

    internal static class GraphValidator
    {
        public static IReadOnlyList<GraphIssue> Validate(GraphJsonDocument document)
        {
            var issues = new List<GraphIssue>();
            var nodes = document.Nodes().ToList();
            var byName = nodes.GroupBy(pair => pair.Node.Value<string>("name") ?? string.Empty, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.ToList(), StringComparer.Ordinal);

            ValidateFields(nodes, issues);
            ValidateNamespace(byName, issues);
            ValidateEdges(document, byName, issues);
            ValidateIdTables(document, byName, issues);
            ValidateProduction(document, byName, issues);
            ValidateComposition(document, byName, issues);
            ValidateCycles(document, byName, issues);
            ValidateWarnings(document, byName, issues);
            return issues;
        }

        private static void ValidateFields(IEnumerable<(string Kind, JObject Node)> nodes, ICollection<GraphIssue> issues)
        {
            foreach (var pair in nodes)
            {
                var name = pair.Node.Value<string>("name") ?? "<unnamed>";
                foreach (var field in GraphSchema.Vertices[pair.Kind].Fields.Where(field => field.Required))
                {
                    var token = pair.Node[field.Name];
                    if (token == null || token.Type == JTokenType.Null || (token.Type == JTokenType.String && string.IsNullOrEmpty(token.Value<string>())))
                        Error(issues, "INV-REQUIRED", $"{pair.Kind} '{name}' is missing required field '{field.Name}'.", name);
                }
            }
        }

        private static void ValidateNamespace(IReadOnlyDictionary<string, List<(string Kind, JObject Node)>> byName, ICollection<GraphIssue> issues)
        {
            foreach (var group in byName.Where(group => group.Value.Count > 1))
                Error(issues, "INV-NAMESPACE", $"Name '{group.Key}' is used by {string.Join(", ", group.Value.Select(value => value.Kind))}.", group.Key);
        }

        private static void ValidateEdges(GraphJsonDocument document, IReadOnlyDictionary<string, List<(string Kind, JObject Node)>> byName, ICollection<GraphIssue> issues)
        {
            foreach (var pair in document.EdgeRows())
            {
                var from = pair.Edge.Value<string>("from");
                var to = pair.Edge.Value<string>("to");
                if (!TryKind(byName, from, out var fromKind) || !TryKind(byName, to, out var toKind))
                {
                    Error(issues, "INV-REF", $"{pair.Kind} edge '{from}' -> '{to}' names a missing endpoint.", from ?? to);
                    continue;
                }
                if (!GraphSchema.Allows(pair.Kind, fromKind, toKind))
                    Error(issues, "INV-REF", $"{pair.Kind} cannot connect {fromKind} '{from}' to {toKind} '{to}'.", from);
                if (pair.Kind == "process")
                {
                    foreach (var input in (pair.Edge["inputs"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        var inputName = input.Value<string>("ingredient");
                        if (!TryKind(byName, inputName, out var inputKind) || inputKind != "ingredient")
                            Error(issues, "INV-REF", $"Process input '{inputName}' is not an ingredient node.", from);
                    }
                    foreach (var chainName in (pair.Edge["chainTools"] as JArray ?? new JArray()).Values<string>())
                        if (!TryKind(byName, chainName, out var chainKind) || chainKind != "tool")
                            Error(issues, "INV-REF", $"Process chain reference '{chainName}' is not a tool node.", from);
                }
            }

            DuplicateCap(document, "process", "to", issues, "INV-UNIQUE-PRODUCER");
            DuplicateCap(document, "base", "from", issues, "INV-BASE-REQUIRED");
            DuplicateCap(document, "topping", "from", issues, "INV-TOPPING-REQUIRED");
            DuplicateCap(document, "leavesDirty", "from", issues, "INV-REF");
        }

        private static void ValidateIdTables(GraphJsonDocument document, IReadOnlyDictionary<string, List<(string Kind, JObject Node)>> byName, ICollection<GraphIssue> issues)
        {
            foreach (var space in GraphSchema.IdSpaces)
            {
                var seen = new HashSet<string>(StringComparer.Ordinal);
                var rows = GraphJsonDocument.Array(document.IdTable, space);
                for (var id = 0; id < rows.Count; id++)
                {
                    var name = rows[id].Value<string>() ?? string.Empty;
                    if (string.IsNullOrEmpty(name))
                    {
                        Error(issues, "INV-IDTABLE-RESOLVES", $"Id {id} in '{space}' names nothing.");
                        continue;
                    }
                    if (!seen.Add(name)) Error(issues, "INV-IDTABLE-UNIQUE", $"'{name}' appears more than once in the '{space}' id table.", name);
                    if (!TryKind(byName, name, out var kind) || kind != space)
                        Error(issues, "INV-IDTABLE-RESOLVES", $"{space} id {id} points to missing or wrong-kind node '{name}'.", name);
                }
            }

            foreach (var pair in document.Nodes())
            {
                var name = pair.Node.Value<string>("name");
                var needsId = pair.Kind == "ingredient" && (pair.Node.Value<bool?>("pickupable") == true || pair.Node.Value<bool?>("servable") == true)
                              || pair.Kind == "composite" && pair.Node.Value<bool?>("orderable") == true;
                if (needsId && !GraphJsonDocument.Array(document.IdTable, pair.Kind).Any(token => token.Value<string>() == name))
                    Warning(issues, "WARN-UNTABLED-NODE", $"{pair.Kind} '{name}' is addressable but has no id-table entry.", name);
            }
        }

        private static void ValidateProduction(GraphJsonDocument document, IReadOnlyDictionary<string, List<(string Kind, JObject Node)>> byName, ICollection<GraphIssue> issues)
        {
            var processes = GraphJsonDocument.Array(document.Edges, "process").OfType<JObject>().ToList();
            var producers = processes.GroupBy(edge => edge.Value<string>("to") ?? string.Empty).ToDictionary(group => group.Key, group => group.ToList());
            foreach (var ingredient in GraphJsonDocument.Array(document.Vertices, "ingredient").OfType<JObject>())
            {
                var name = ingredient.Value<string>("name");
                var count = producers.TryGetValue(name ?? string.Empty, out var rows) ? rows.Count : 0;
                if (count > 1) Error(issues, "INV-UNIQUE-PRODUCER", $"Ingredient '{name}' has {count} producer edges.", name);
                if (count == 0 && ingredient.Value<bool?>("pickupable") != true)
                    Error(issues, "INV-UNIQUE-PRODUCER", $"Ingredient '{name}' is neither pickupable nor produced.", name);
            }

            var stableSlots = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var edge in processes)
            {
                var toolName = edge.Value<string>("from");
                var targetName = edge.Value<string>("to");
                var tool = toolName == null ? null : document.FindNode("tool", toolName);
                var slotCount = (tool?["slotConfigs"] as JArray)?.Count ?? 0;
                var inputs = edge["inputs"] as JArray ?? new JArray();
                if (inputs.Count == 0)
                    Error(issues, "INV-TRACEABLE", $"Process '{toolName}' -> '{targetName}' has no inputs.", targetName);
                if (inputs.Count > 1) Warning(issues, "WARN-MULTI-INPUT", $"Process '{toolName}' -> '{targetName}' has multiple inputs.", targetName);
                foreach (var input in inputs.OfType<JObject>())
                {
                    var ingredient = input.Value<string>("ingredient");
                    var slot = input.Value<int?>("slot") ?? 0;
                    if (slot < 0 || slot >= slotCount)
                        Error(issues, "INV-INPUT-SLOT-RANGE", $"Input '{ingredient}' uses slot {slot}, outside tool '{toolName}'.", toolName);
                    var key = toolName + "\0" + ingredient;
                    if (stableSlots.TryGetValue(key, out var previous) && previous != slot)
                        Error(issues, "INV-INPUT-SLOT-STABLE", $"'{ingredient}' enters '{toolName}' at both slot {previous} and {slot}.", toolName);
                    else stableSlots[key] = slot;
                }

                var target = targetName == null ? null : document.FindNode("ingredient", targetName);
                if (target != null && target.Value<bool?>("servable") != true && (edge.Value<int?>("amount") ?? 1) != 1)
                    Error(issues, "INV-INTERMEDIATE-AMOUNT", $"Non-servable intermediate '{targetName}' must have process amount 1.", targetName);

                var usedSlots = inputs.OfType<JObject>().Select(value => value.Value<int?>("slot") ?? 0).Distinct().ToList();
                if (usedSlots.Count > 1 && tool?["slotConfigs"] is JArray configs)
                {
                    var lanes = usedSlots.Where(index => index >= 0 && index < configs.Count)
                        .Select(index => (configs[index] as JObject)?.Value<int?>("slot") ?? 1).Distinct().ToList();
                    if (lanes.Count > 1) Warning(issues, "WARN-UNEVEN-LANES", $"Multi-input process '{toolName}' -> '{targetName}' uses points with unequal lane counts.", toolName);
                }
            }
        }

        private static void ValidateComposition(GraphJsonDocument document, IReadOnlyDictionary<string, List<(string Kind, JObject Node)>> byName, ICollection<GraphIssue> issues)
        {
            var bases = GraphJsonDocument.Array(document.Edges, "base").OfType<JObject>().ToList();
            var toppings = GraphJsonDocument.Array(document.Edges, "topping").OfType<JObject>().ToList();
            var options = GraphJsonDocument.Array(document.Edges, "option").OfType<JObject>().ToList();
            foreach (var composite in GraphJsonDocument.Array(document.Vertices, "composite").OfType<JObject>())
            {
                var name = composite.Value<string>("name");
                var baseCount = bases.Count(edge => edge.Value<string>("from") == name);
                if (baseCount != 1) Error(issues, "INV-BASE-REQUIRED", $"Composite '{name}' must have exactly one base edge; found {baseCount}.", name);
                if (composite.Value<bool?>("toppingRequired") == true && !toppings.Any(edge => edge.Value<string>("from") == name))
                    Error(issues, "INV-TOPPING-REQUIRED", $"Composite '{name}' requires a topping but has no topping edge.", name);

                var slots = bases.Concat(toppings).Where(edge => edge.Value<string>("from") == name).Select(edge => edge.Value<string>("to")).ToList();
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var slot in slots)
                {
                    var leaves = CompositionLeaves(slot, document, new HashSet<string>(StringComparer.Ordinal));
                    foreach (var leaf in leaves)
                    {
                        if (!seen.Add(leaf)) Error(issues, "INV-ORDER-REBUILDABLE", $"Ingredient '{leaf}' is offered by multiple slots of composite '{name}'.", name);
                        var ingredient = document.FindNode("ingredient", leaf);
                        if (ingredient != null && ingredient.Value<bool?>("servable") != true)
                            Error(issues, "INV-SERVABLE", $"Ingredient '{leaf}' is used in an order slot but is not servable.", leaf);
                    }
                }

                if (composite.Value<bool?>("orderable") == true)
                {
                    foreach (var leaf in slots.SelectMany(slot => CompositionLeaves(slot, document, new HashSet<string>(StringComparer.Ordinal))).Distinct())
                    {
                        if (!CanProduce(leaf, document, new HashSet<string>(StringComparer.Ordinal)))
                            Error(issues, "INV-TRACEABLE", $"Orderable '{name}' reaches unobtainable ingredient '{leaf}'.", name);
                    }
                }
            }

            foreach (var group in GraphJsonDocument.Array(document.Vertices, "group").OfType<JObject>())
            {
                var name = group.Value<string>("name");
                var count = options.Count(edge => edge.Value<string>("from") == name);
                if (count == 0) Error(issues, "INV-GROUP-NONEMPTY", $"Group '{name}' has no options.", name);
                if (count == 1 && (group.Value<int?>("maxQuantity") ?? -1) == 1)
                    Warning(issues, "WARN-DEGENERATE-CHOICE", $"Group '{name}' has one option and permits one pick.", name);
            }
        }

        private static void ValidateCycles(GraphJsonDocument document, IReadOnlyDictionary<string, List<(string Kind, JObject Node)>> byName, ICollection<GraphIssue> issues)
        {
            var arcs = document.EdgeRows().Where(pair => pair.Kind == "base" || pair.Kind == "topping" || pair.Kind == "option")
                .Select(pair => (From: pair.Edge.Value<string>("from"), To: pair.Edge.Value<string>("to"))).ToList();
            foreach (var process in GraphJsonDocument.Array(document.Edges, "process").OfType<JObject>())
                foreach (var input in (process["inputs"] as JArray ?? new JArray()).OfType<JObject>())
                    arcs.Add((process.Value<string>("to"), input.Value<string>("ingredient")));
            var adjacency = arcs.Where(arc => arc.From != null && arc.To != null).GroupBy(arc => arc.From)
                .ToDictionary(group => group.Key, group => group.Select(arc => arc.To).ToList());
            var visiting = new HashSet<string>(StringComparer.Ordinal);
            var visited = new HashSet<string>(StringComparer.Ordinal);
            bool Visit(string node)
            {
                if (!visiting.Add(node)) return true;
                if (visited.Contains(node)) { visiting.Remove(node); return false; }
                if (adjacency.TryGetValue(node, out var next) && next.Any(Visit)) return true;
                visiting.Remove(node);
                visited.Add(node);
                return false;
            }
            foreach (var name in byName.Keys)
                if (!visited.Contains(name) && Visit(name))
                {
                    Error(issues, "INV-ACYCLIC", $"Graph contains a cycle involving '{name}'.", name);
                    break;
                }
        }

        private static void ValidateWarnings(GraphJsonDocument document, IReadOnlyDictionary<string, List<(string Kind, JObject Node)>> byName, ICollection<GraphIssue> issues)
        {
            var processes = GraphJsonDocument.Array(document.Edges, "process").OfType<JObject>().ToList();
            foreach (var tool in GraphJsonDocument.Array(document.Vertices, "tool").OfType<JObject>())
            {
                var name = tool.Value<string>("name");
                if (!processes.Any(edge => edge.Value<string>("from") == name)) Warning(issues, "WARN-EMPTY-TOOL", $"Tool '{name}' has no process edges.", name);
            }

            var orderRoots = GraphJsonDocument.Array(document.Vertices, "composite").OfType<JObject>()
                .Where(node => node.Value<bool?>("orderable") == true).Select(node => node.Value<string>("name")).ToList();
            var reachable = new HashSet<string>(StringComparer.Ordinal);
            foreach (var root in orderRoots) CollectComposition(root, document, reachable);
            // An order reaches finished ingredients through composition edges;
            // the pickupable raws and intermediate outputs that make those
            // ingredients are also used, even though they are not dish slots.
            var expanded = true;
            while (expanded)
            {
                expanded = false;
                foreach (var process in processes.Where(edge => reachable.Contains(edge.Value<string>("to"))))
                {
                    if (reachable.Add(process.Value<string>("from"))) expanded = true;
                    foreach (var input in (process["inputs"] as JArray ?? new JArray()).OfType<JObject>())
                        if (reachable.Add(input.Value<string>("ingredient"))) expanded = true;
                    foreach (var tool in (process["chainTools"] as JArray ?? new JArray()).Values<string>())
                        if (reachable.Add(tool)) expanded = true;
                }
            }
            foreach (var ingredient in GraphJsonDocument.Array(document.Vertices, "ingredient").OfType<JObject>())
            {
                var name = ingredient.Value<string>("name");
                if (ingredient.Value<bool?>("pickupable") == true && !reachable.Contains(name))
                    Warning(issues, "WARN-UNUSED-PICKUP", $"Pickupable ingredient '{name}' is not used by an orderable.", name);
                if (processes.Any(edge => edge.Value<string>("to") == name) && !reachable.Contains(name))
                    Warning(issues, "WARN-ORPHAN-OUTPUT", $"Produced ingredient '{name}' is not used by an orderable.", name);
            }
            foreach (var group in GraphJsonDocument.Array(document.Vertices, "group").OfType<JObject>())
            {
                var name = group.Value<string>("name");
                if (reachable.Contains(name) && (group.Value<int?>("maxQuantity") ?? -1) < 0)
                    Warning(issues, "WARN-UNBOUNDED", $"Reachable group '{name}' has unbounded quantity.", name);
            }
            foreach (var composite in GraphJsonDocument.Array(document.Vertices, "composite").OfType<JObject>())
            {
                var name = composite.Value<string>("name");
                if (composite.Value<bool?>("orderable") != true && !reachable.Contains(name))
                    Warning(issues, "WARN-UNREACHED-COMPOSITE", $"Composite '{name}' is not reached by an orderable.", name);
            }
        }

        private static IEnumerable<string> CompositionLeaves(string name, GraphJsonDocument document, ISet<string> visiting)
        {
            if (string.IsNullOrEmpty(name) || !visiting.Add(name)) return Enumerable.Empty<string>();
            var kind = document.FindKind(name);
            if (kind == "ingredient") return new[] { name };
            var edgeKinds = kind == "group" ? new[] { "option" } : kind == "composite" ? new[] { "base", "topping" } : Array.Empty<string>();
            return edgeKinds.SelectMany(edgeKind => GraphJsonDocument.Array(document.Edges, edgeKind).OfType<JObject>()
                .Where(edge => edge.Value<string>("from") == name)
                .SelectMany(edge => CompositionLeaves(edge.Value<string>("to"), document, new HashSet<string>(visiting, StringComparer.Ordinal)))).Distinct();
        }

        private static bool CanProduce(string ingredientName, GraphJsonDocument document, ISet<string> visiting)
        {
            if (!visiting.Add(ingredientName)) return false;
            var ingredient = document.FindNode("ingredient", ingredientName);
            if (ingredient == null) return false;
            if (ingredient.Value<bool?>("pickupable") == true) return true;
            var process = GraphJsonDocument.Array(document.Edges, "process").OfType<JObject>().FirstOrDefault(edge => edge.Value<string>("to") == ingredientName);
            if (process == null) return false;
            var inputs = process["inputs"] as JArray;
            return inputs != null && inputs.Count > 0 && inputs.OfType<JObject>().All(input => CanProduce(input.Value<string>("ingredient"), document, new HashSet<string>(visiting, StringComparer.Ordinal)));
        }

        private static void CollectComposition(string name, GraphJsonDocument document, ISet<string> result)
        {
            if (string.IsNullOrEmpty(name) || !result.Add(name)) return;
            var kind = document.FindKind(name);
            var edgeKinds = kind == "group" ? new[] { "option" } : kind == "composite" ? new[] { "base", "topping" } : Array.Empty<string>();
            foreach (var edgeKind in edgeKinds)
                foreach (var edge in GraphJsonDocument.Array(document.Edges, edgeKind).OfType<JObject>().Where(edge => edge.Value<string>("from") == name))
                    CollectComposition(edge.Value<string>("to"), document, result);
        }

        private static void DuplicateCap(GraphJsonDocument document, string edgeKind, string field, ICollection<GraphIssue> issues, string code)
        {
            foreach (var group in GraphJsonDocument.Array(document.Edges, edgeKind).OfType<JObject>().GroupBy(edge => edge.Value<string>(field)).Where(group => group.Count() > 1))
                Error(issues, code, $"{edgeKind} permits only one edge for '{group.Key}', found {group.Count()}.", group.Key);
        }

        private static bool TryKind(IReadOnlyDictionary<string, List<(string Kind, JObject Node)>> byName, string name, out string kind)
        {
            if (name != null && byName.TryGetValue(name, out var rows) && rows.Count == 1)
            {
                kind = rows[0].Kind;
                return true;
            }
            kind = null;
            return false;
        }

        private static void Error(ICollection<GraphIssue> issues, string code, string message, string node = null) => issues.Add(new GraphIssue(GraphIssueSeverity.Error, code, message, node));
        private static void Warning(ICollection<GraphIssue> issues, string code, string message, string node = null) => issues.Add(new GraphIssue(GraphIssueSeverity.Warning, code, message, node));
    }
}
