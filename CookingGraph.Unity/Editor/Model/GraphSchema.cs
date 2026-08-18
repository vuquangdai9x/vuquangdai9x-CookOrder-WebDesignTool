using System;
using System.Collections.Generic;
using System.Linq;

namespace CookingGraph.Editor
{
    internal sealed class GraphFieldDefinition
    {
        public string Name { get; }
        public string Type { get; }
        public bool Required { get; }
        public object DefaultValue { get; }
        public string[] ReferenceKinds { get; }

        public GraphFieldDefinition(string name, string type, bool required = false, object defaultValue = null, params string[] referenceKinds)
        {
            Name = name;
            Type = type;
            Required = required;
            DefaultValue = defaultValue;
            ReferenceKinds = referenceKinds ?? Array.Empty<string>();
        }
    }

    internal sealed class VertexDefinition
    {
        public string Kind { get; }
        public string Label { get; }
        public string Color { get; }
        public IReadOnlyList<GraphFieldDefinition> Fields { get; }

        public VertexDefinition(string kind, string label, string color, params GraphFieldDefinition[] fields)
        {
            Kind = kind;
            Label = label;
            Color = color;
            Fields = fields;
        }
    }

    internal sealed class EdgeDefinition
    {
        public string Kind { get; }
        public string Label { get; }
        public string[] From { get; }
        public string[] To { get; }
        public IReadOnlyList<GraphFieldDefinition> Fields { get; }

        public EdgeDefinition(string kind, string label, string[] from, string[] to, params GraphFieldDefinition[] fields)
        {
            Kind = kind;
            Label = label;
            From = from;
            To = to;
            Fields = fields;
        }
    }

    internal static class GraphSchema
    {
        public const int SupportedVersion = 1;
        public static readonly string[] VertexKinds = { "ingredient", "tool", "group", "composite", "dirty" };
        public static readonly string[] EdgeKinds = { "process", "base", "topping", "option", "leavesDirty" };
        public static readonly string[] IdSpaces = { "ingredient", "composite", "group", "tool", "dirty" };

        public static readonly IReadOnlyList<GraphFieldDefinition> MapFields = new[]
        {
            F("id", "string", true), F("name", "string", true), F("gridWidth", "int", true, 4),
            F("gridHeight", "int", true, 4), F("dirtyStackHeight", "int", true, 3),
            F("visibleRows", "int", true, 3), F("customerAvatars", "string[]")
        };

        public static readonly IReadOnlyDictionary<string, VertexDefinition> Vertices = new[]
        {
            new VertexDefinition("ingredient", "Ingredient", "#6bbf59",
                F("name", "string", true), F("displayName", "string", true), F("pickupable", "bool", false, false),
                F("servable", "bool", false, false), F("usageNum", "int", false, 1), F("price", "int", false, 0),
                F("code", "string"), F("emoji", "string"), F("localImage", "string"), F("fileId", "string")),
            new VertexDefinition("tool", "Tool", "#f0a441",
                F("name", "string", true), F("displayName", "string", true), F("slotConfigs", "slotConfig[]", true),
                F("cookingTime", "number", true, 1f), F("upgradeCosts", "int[]"), F("emoji", "string"),
                F("localImage", "string"), F("fileId", "string"), F("runtimeToolId", "int")),
            new VertexDefinition("group", "Group", "#a978de",
                F("name", "string", true), F("displayName", "string", true), F("minQuantity", "int", false, 0),
                F("maxQuantity", "int", false, -1)),
            new VertexDefinition("composite", "Composite", "#4f8fdb",
                F("name", "string", true), F("displayName", "string", true), F("orderable", "bool", false, false),
                F("toppingRequired", "bool", false, false)),
            new VertexDefinition("dirty", "Dirty", "#888888",
                F("name", "string", true), F("displayName", "string", true), F("emoji", "string"),
                F("localImage", "string"), F("fileId", "string"), F("runtimeDirtyId", "int"))
        }.ToDictionary(value => value.Kind);

        public static readonly IReadOnlyDictionary<string, EdgeDefinition> Edges = new[]
        {
            new EdgeDefinition("process", "Process", new[] { "tool" }, new[] { "ingredient" },
                F("inputs", "processInput[]", true), F("amount", "int", true, 1), F("duration", "number"), F("chainTools", "ref[]", false, null, "tool")),
            new EdgeDefinition("base", "Base", new[] { "composite" }, new[] { "ingredient", "group", "composite" }),
            new EdgeDefinition("topping", "Topping", new[] { "composite" }, new[] { "ingredient", "group", "composite" }),
            new EdgeDefinition("option", "Option", new[] { "group" }, new[] { "ingredient", "group", "composite" }, F("maxQuantity", "int", false, -1)),
            new EdgeDefinition("leavesDirty", "Leaves Dirty", new[] { "composite" }, new[] { "dirty" })
        }.ToDictionary(value => value.Kind);

        public static bool Allows(string edgeKind, string fromKind, string toKind)
        {
            return Edges.TryGetValue(edgeKind, out var edge) && edge.From.Contains(fromKind) && edge.To.Contains(toKind);
        }

        public static string IdSpaceFor(string vertexKind) => vertexKind;

        private static GraphFieldDefinition F(string name, string type, bool required = false, object defaultValue = null, params string[] refs)
        {
            return new GraphFieldDefinition(name, type, required, defaultValue, refs);
        }
    }
}
