using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace CookingGraph.Editor
{
    internal sealed class GraphSyncDifference
    {
        public readonly List<string> Missing = new List<string>();
        public readonly List<string> Changed = new List<string>();
        public readonly List<string> Unchanged = new List<string>();
        public readonly List<string> Redundant = new List<string>();
        internal readonly List<SyncNode> Nodes = new List<SyncNode>();
        internal CookingGraphEditorData ExistingState;

        public string Summary()
        {
            var builder = new StringBuilder();
            Append(builder, "Missing / new", Missing);
            Append(builder, "Changed", Changed);
            Append(builder, "Unchanged", Unchanged);
            Append(builder, "Redundant (kept on disk)", Redundant);
            return builder.ToString();
        }

        private static void Append(StringBuilder builder, string heading, IReadOnlyList<string> rows)
        {
            builder.AppendLine($"{heading}: {rows.Count}");
            foreach (var row in rows.Take(12)) builder.AppendLine("  • " + row);
            if (rows.Count > 12) builder.AppendLine($"  … and {rows.Count - 12} more");
            builder.AppendLine();
        }
    }

    internal sealed class SyncNode
    {
        public string Kind;
        public string Name;
        public JObject Json;
        public int DataId;
        public string Fingerprint;
        public GeneratedNodeMapping Existing;
    }

    internal static class GraphAssetSynchronizer
    {
        public static string OutputRoot(string mapId, CookingGraphGenerationConfig config = null) =>
            GenerationPath.Resolve(config?.outputFolderFormat, config?.mapIndex ?? 0, mapId);
        public static string MasterPath(string mapId, CookingGraphGenerationConfig config = null) => $"{OutputRoot(mapId, config)}/{SafePathPart(mapId)}.asset";
        public static string EditorDataPath(string mapId, CookingGraphGenerationConfig config = null) => $"{OutputRoot(mapId, config)}/Editor/{SafePathPart(mapId)}-EditorData.asset";

        public static bool HasGeneratedAssets(string mapId, CookingGraphGenerationConfig config = null)
        {
            return AssetDatabase.LoadAssetAtPath<CookingGraphAsset>(MasterPath(mapId, config)) != null
                   || AssetDatabase.LoadAssetAtPath<CookingGraphEditorData>(EditorDataPath(mapId, config)) != null;
        }

        public static CookingNodeAsset ResolveSpriteAsset(string mapId, string kind, string nodeName, CookingGraphGenerationConfig config = null)
        {
            var state = AssetDatabase.LoadAssetAtPath<CookingGraphEditorData>(EditorDataPath(mapId, config));
            return state?.activeNodes.FirstOrDefault(mapping => mapping.kind == kind && mapping.nodeName == nodeName)?.asset;
        }

        public static GraphSyncDifference Compare(GraphJsonDocument document, CookingGraphGenerationConfig config = null)
        {
            var diff = new GraphSyncDifference
            {
                ExistingState = AssetDatabase.LoadAssetAtPath<CookingGraphEditorData>(EditorDataPath(document.MapId, config))
            };
            var available = new List<GeneratedNodeMapping>();
            if (diff.ExistingState != null)
            {
                available.AddRange(diff.ExistingState.activeNodes.Where(mapping => mapping != null));
                available.AddRange(diff.ExistingState.orphanedNodes.Where(mapping => mapping != null));
            }
            else
            {
                available.AddRange(ReconstructMappings(AssetDatabase.LoadAssetAtPath<CookingGraphAsset>(MasterPath(document.MapId, config))));
            }

            var previousIds = ParsePreviousIds(diff.ExistingState?.previousIdTablesJson);
            var used = new HashSet<GeneratedNodeMapping>();
            foreach (var pair in document.Nodes())
            {
                var name = pair.Node.Value<string>("name");
                var dataId = IdOf(document, pair.Kind, name);
                var mapping = available.FirstOrDefault(value => !used.Contains(value) && value.kind == pair.Kind && value.nodeName == name);
                if (mapping == null && dataId >= 0 && previousIds.TryGetValue(pair.Kind, out var previousRows) && dataId < previousRows.Count)
                {
                    var previousName = previousRows[dataId];
                    mapping = available.FirstOrDefault(value => !used.Contains(value) && value.kind == pair.Kind && value.nodeName == previousName);
                }
                if (mapping != null) used.Add(mapping);
                var fingerprint = Fingerprint(pair.Kind, pair.Node);
                var syncNode = new SyncNode
                {
                    Kind = pair.Kind,
                    Name = name,
                    Json = pair.Node,
                    DataId = dataId,
                    Fingerprint = fingerprint,
                    Existing = mapping
                };
                diff.Nodes.Add(syncNode);
                var label = pair.Kind + ":" + name;
                if (mapping?.asset == null) diff.Missing.Add(label);
                else if (!string.Equals(mapping.fingerprint, fingerprint, StringComparison.Ordinal)) diff.Changed.Add(label);
                else diff.Unchanged.Add(label);
            }

            foreach (var mapping in available.Where(mapping => mapping.asset != null && !used.Contains(mapping)).Distinct())
                diff.Redundant.Add(mapping.kind + ":" + mapping.nodeName);
            return diff;
        }

        public static CookingGraphAsset Synchronize(GraphJsonDocument document, string sourcePath, GraphSyncDifference diff, CookingGraphGenerationConfig config = null)
        {
            if (diff == null) diff = Compare(document, config);
            var outputRoot = OutputRoot(document.MapId, config);
            EnsureFolder(outputRoot);
            foreach (var kind in GraphSchema.VertexKinds) EnsureFolder($"{outputRoot}/Nodes/{KindFolder(kind)}");
            EnsureFolder($"{outputRoot}/Editor");

            var state = diff.ExistingState;
            if (state == null)
            {
                state = ScriptableObject.CreateInstance<CookingGraphEditorData>();
                AssetDatabase.CreateAsset(state, EditorDataPath(document.MapId, config));
            }

            var previousMappings = state.activeNodes.Concat(state.orphanedNodes).Where(value => value != null).ToList();
            var active = new List<GeneratedNodeMapping>();
            foreach (var node in diff.Nodes)
            {
                var mapping = node.Existing ?? new GeneratedNodeMapping();
                var asset = mapping.asset;
                if (asset == null)
                {
                    asset = CreateNodeAsset(node.Kind);
                    var filename = SafePathPart(node.Name) + ".asset";
                    var path = AssetDatabase.GenerateUniqueAssetPath($"{outputRoot}/Nodes/{KindFolder(node.Kind)}/{filename}");
                    AssetDatabase.CreateAsset(asset, path);
                }
                ApplyNode(node.Kind, node.Json, asset);
                EditorUtility.SetDirty(asset);
                mapping.kind = node.Kind;
                mapping.nodeName = node.Name;
                mapping.dataId = node.DataId;
                mapping.fingerprint = node.Fingerprint;
                mapping.asset = asset;
                active.Add(mapping);
            }

            var activeAssets = new HashSet<CookingNodeAsset>(active.Select(mapping => mapping.asset));
            var orphans = previousMappings.Where(mapping => mapping.asset != null && !activeAssets.Contains(mapping.asset)).ToList();
            foreach (var mapping in state.orphanedNodes.Where(mapping => mapping?.asset != null && !activeAssets.Contains(mapping.asset)))
                if (orphans.All(value => value.asset != mapping.asset)) orphans.Add(mapping);

            var master = AssetDatabase.LoadAssetAtPath<CookingGraphAsset>(MasterPath(document.MapId, config));
            if (master == null)
            {
                master = ScriptableObject.CreateInstance<CookingGraphAsset>();
                AssetDatabase.CreateAsset(master, MasterPath(document.MapId, config));
            }
            PopulateMaster(document, master, active);
            EditorUtility.SetDirty(master);

            state.sourcePath = sourcePath ?? string.Empty;
            state.sourceGuid = ToAssetPath(sourcePath) is string assetPath && !string.IsNullOrEmpty(assetPath) ? AssetDatabase.AssetPathToGUID(assetPath) : string.Empty;
            state.sourceHash = Hash(document.ToJson());
            state.mapIndex = config?.mapIndex ?? 0;
            state.outputFolderFormat = config?.outputFolderFormat ?? GenerationPath.DefaultFormat;
            state.layoutJson = document.Layout.ToString(Formatting.Indented);
            state.notesJson = document.Notes.ToString(Formatting.Indented);
            state.previousIdTablesJson = document.IdTable.ToString(Formatting.None);
            state.previousDocumentJson = document.ToJson();
            state.runtimeGraph = master;
            state.activeNodes = active;
            state.orphanedNodes = orphans;
            EditorUtility.SetDirty(state);
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            return master;
        }

        private static void PopulateMaster(GraphJsonDocument document, CookingGraphAsset graph, IReadOnlyList<GeneratedNodeMapping> mappings)
        {
            var lookup = mappings.Where(mapping => mapping.asset != null).ToDictionary(mapping => mapping.nodeName, mapping => mapping.asset, StringComparer.Ordinal);
            graph.schemaVersion = document.SchemaVersion;
            graph.map = new CookingMapData
            {
                id = document.Map.Value<string>("id"), name = document.Map.Value<string>("name"),
                gridWidth = document.Map.Value<int?>("gridWidth") ?? 4, gridHeight = document.Map.Value<int?>("gridHeight") ?? 4,
                dirtyStackHeight = document.Map.Value<int?>("dirtyStackHeight") ?? 3, visibleRows = document.Map.Value<int?>("visibleRows") ?? 3
            };
            graph.ingredients = mappings.Select(value => value.asset).OfType<IngredientNodeAsset>().ToList();
            graph.tools = mappings.Select(value => value.asset).OfType<ToolNodeAsset>().ToList();
            graph.groups = mappings.Select(value => value.asset).OfType<GroupNodeAsset>().ToList();
            graph.composites = mappings.Select(value => value.asset).OfType<CompositeNodeAsset>().ToList();
            graph.dirtyObjects = mappings.Select(value => value.asset).OfType<DirtyNodeAsset>().ToList();
            graph.idTable = new CookingIdTables
            {
                ingredient = ResolveTable<IngredientNodeAsset>(document, "ingredient", lookup),
                composite = ResolveTable<CompositeNodeAsset>(document, "composite", lookup),
                group = ResolveTable<GroupNodeAsset>(document, "group", lookup),
                tool = ResolveTable<ToolNodeAsset>(document, "tool", lookup),
                dirty = ResolveTable<DirtyNodeAsset>(document, "dirty", lookup)
            };
            graph.processEdges = GraphJsonDocument.Array(document.Edges, "process").OfType<JObject>().Select(edge => new ProcessEdgeAssetData
            {
                from = Resolve<ToolNodeAsset>(lookup, edge.Value<string>("from")),
                to = Resolve<IngredientNodeAsset>(lookup, edge.Value<string>("to")),
                amount = edge.Value<int?>("amount") ?? 1,
                auto = edge.Value<bool?>("auto") ?? true,
                duration = OptionalFloatOf(edge, "duration"),
                inputs = (edge["inputs"] as JArray ?? new JArray()).OfType<JObject>().Select(input => new ProcessInputAssetData
                {
                    ingredient = Resolve<IngredientNodeAsset>(lookup, input.Value<string>("ingredient")), slot = input.Value<int?>("slot") ?? 0
                }).ToList(),
                chainTools = (edge["chainTools"] as JArray ?? new JArray()).Select(token => Resolve<ToolNodeAsset>(lookup, token.Value<string>())).ToList()
            }).ToList();
            graph.preservationEdges = GraphJsonDocument.Array(document.Edges, "preservation").OfType<JObject>().Select(edge => new PreservationEdgeAssetData
            {
                from = Resolve<ToolNodeAsset>(lookup, edge.Value<string>("from")),
                to = Resolve<CookingNodeAsset>(lookup, edge.Value<string>("to"))
            }).ToList();
            graph.baseEdges = SimpleEdges(document, "base", lookup);
            graph.toppingEdges = SimpleEdges(document, "topping", lookup);
            graph.optionEdges = GraphJsonDocument.Array(document.Edges, "option").OfType<JObject>().Select(edge => new OptionEdgeAssetData
            {
                from = Resolve<GroupNodeAsset>(lookup, edge.Value<string>("from")),
                to = Resolve<CookingNodeAsset>(lookup, edge.Value<string>("to")),
                maxQuantity = OptionalIntOf(edge, "maxQuantity")
            }).ToList();
            graph.leavesDirtyEdges = GraphJsonDocument.Array(document.Edges, "leavesDirty").OfType<JObject>().Select(edge => new DirtyEdgeAssetData
            {
                from = Resolve<CompositeNodeAsset>(lookup, edge.Value<string>("from")),
                to = Resolve<DirtyNodeAsset>(lookup, edge.Value<string>("to"))
            }).ToList();
        }

        private static List<NodeEdgeAssetData> SimpleEdges(GraphJsonDocument document, string kind, IReadOnlyDictionary<string, CookingNodeAsset> lookup)
        {
            return GraphJsonDocument.Array(document.Edges, kind).OfType<JObject>().Select(edge => new NodeEdgeAssetData
            {
                from = Resolve<CookingNodeAsset>(lookup, edge.Value<string>("from")),
                to = Resolve<CookingNodeAsset>(lookup, edge.Value<string>("to"))
            }).ToList();
        }

        private static void ApplyNode(string kind, JObject json, CookingNodeAsset asset)
        {
            asset.nodeName = json.Value<string>("name") ?? string.Empty;
            asset.displayName = json.Value<string>("displayName") ?? asset.nodeName;
            asset.emoji = json.Value<string>("emoji") ?? string.Empty;
            switch (kind)
            {
                case "ingredient":
                    var ingredient = (IngredientNodeAsset)asset;
                    ingredient.pickupable = json.Value<bool?>("pickupable") ?? false;
                    ingredient.usageNum = json.Value<int?>("usageNum") ?? 1;
                    ingredient.price = json.Value<int?>("price") ?? 0;
                    ingredient.code = json.Value<string>("code") ?? string.Empty;
                    break;
                case "tool":
                    var tool = (ToolNodeAsset)asset;
                    tool.cookingTime = json.Value<float?>("cookingTime") ?? 0;
                    tool.slotConfigs = (json["slotConfigs"] as JArray ?? new JArray()).OfType<JObject>().Select(slot => new ToolSlotConfig
                    {
                        name = slot.Value<string>("name") ?? string.Empty, slot = slot.Value<int?>("slot") ?? 1
                    }).ToList();
                    tool.preservationSlots = Math.Max(0, json.Value<int?>("preservationSlots") ?? 0);
                    tool.upgradeCosts = (json["upgradeCosts"] as JArray ?? new JArray()).Select(token => token.Value<int>()).ToList();
                    tool.runtimeToolId = OptionalIntOf(json, "runtimeToolId");
                    break;
                case "group":
                    ((GroupNodeAsset)asset).minQuantity = Math.Max(0, json.Value<int?>("minQuantity") ?? 0);
                    ((GroupNodeAsset)asset).maxQuantity = OptionalIntOf(json, "maxQuantity");
                    break;
                case "composite":
                    ((CompositeNodeAsset)asset).orderable = json.Value<bool?>("orderable") ?? false;
                    ((CompositeNodeAsset)asset).toppingRequired = json.Value<bool?>("toppingRequired") ?? false;
                    break;
                case "dirty":
                    ((DirtyNodeAsset)asset).maxStack = OptionalIntOf(json, "maxStack");
                    ((DirtyNodeAsset)asset).runtimeDirtyId = OptionalIntOf(json, "runtimeDirtyId");
                    break;
            }
        }

        private static CookingNodeAsset CreateNodeAsset(string kind)
        {
            switch (kind)
            {
                case "ingredient": return ScriptableObject.CreateInstance<IngredientNodeAsset>();
                case "tool": return ScriptableObject.CreateInstance<ToolNodeAsset>();
                case "group": return ScriptableObject.CreateInstance<GroupNodeAsset>();
                case "composite": return ScriptableObject.CreateInstance<CompositeNodeAsset>();
                case "dirty": return ScriptableObject.CreateInstance<DirtyNodeAsset>();
                default: throw new ArgumentOutOfRangeException(nameof(kind), kind, null);
            }
        }

        private static List<GeneratedNodeMapping> ReconstructMappings(CookingGraphAsset graph)
        {
            if (graph == null) return new List<GeneratedNodeMapping>();
            var rows = new List<GeneratedNodeMapping>();
            void Add(string kind, IEnumerable<CookingNodeAsset> assets)
            {
                foreach (var asset in assets.Where(value => value != null)) rows.Add(new GeneratedNodeMapping { kind = kind, nodeName = asset.nodeName, asset = asset });
            }
            Add("ingredient", graph.ingredients); Add("tool", graph.tools); Add("group", graph.groups); Add("composite", graph.composites); Add("dirty", graph.dirtyObjects);
            return rows;
        }

        private static Dictionary<string, List<string>> ParsePreviousIds(string json)
        {
            try
            {
                var root = string.IsNullOrEmpty(json) ? null : JObject.Parse(json);
                return GraphSchema.IdSpaces.ToDictionary(space => space,
                    space => (root?[space] as JArray ?? new JArray()).Select(token => token.Value<string>() ?? string.Empty).ToList());
            }
            catch { return new Dictionary<string, List<string>>(); }
        }

        private static int IdOf(GraphJsonDocument document, string kind, string name)
        {
            var rows = GraphJsonDocument.Array(document.IdTable, kind);
            for (var index = 0; index < rows.Count; index++) if (rows[index].Value<string>() == name) return index;
            return -1;
        }

        private static string Fingerprint(string kind, JObject source)
        {
            var clone = (JObject)source.DeepClone();
            clone.Remove("localImage");
            clone.Remove("fileId");
            clone.Remove("imageURL");
            return Hash(kind + "\n" + clone.ToString(Formatting.None));
        }

        private static string Hash(string source)
        {
            using (var sha = SHA256.Create())
                return string.Concat(sha.ComputeHash(Encoding.UTF8.GetBytes(source ?? string.Empty)).Select(value => value.ToString("x2")));
        }

        private static OptionalInt OptionalIntOf(JObject json, string field)
        {
            return new OptionalInt { hasValue = json[field]?.Type == JTokenType.Integer, value = json.Value<int?>(field) ?? 0 };
        }

        private static OptionalFloat OptionalFloatOf(JObject json, string field)
        {
            var present = json[field]?.Type == JTokenType.Integer || json[field]?.Type == JTokenType.Float;
            return new OptionalFloat { hasValue = present, value = json.Value<float?>(field) ?? 0 };
        }

        private static T Resolve<T>(IReadOnlyDictionary<string, CookingNodeAsset> lookup, string name) where T : CookingNodeAsset
        {
            return name != null && lookup.TryGetValue(name, out var asset) ? asset as T : null;
        }

        private static List<T> ResolveTable<T>(GraphJsonDocument document, string space, IReadOnlyDictionary<string, CookingNodeAsset> lookup) where T : CookingNodeAsset
        {
            return GraphJsonDocument.Array(document.IdTable, space).Select(token => Resolve<T>(lookup, token.Value<string>())).ToList();
        }

        private static string KindFolder(string kind) => char.ToUpperInvariant(kind[0]) + kind.Substring(1);
        private static string SafePathPart(string value)
        {
            var safe = Regex.Replace(value ?? "map", "[^A-Za-z0-9._-]+", "-").Trim('-');
            return string.IsNullOrEmpty(safe) ? "map" : safe;
        }

        private static void EnsureFolder(string path)
        {
            var parts = path.Replace('\\', '/').Split('/');
            var current = parts[0];
            for (var index = 1; index < parts.Length; index++)
            {
                var next = current + "/" + parts[index];
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(current, parts[index]);
                current = next;
            }
        }

        private static string ToAssetPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            var full = Path.GetFullPath(path).Replace('\\', '/');
            var project = Path.GetFullPath(Path.Combine(Application.dataPath, "..")).Replace('\\', '/').TrimEnd('/') + "/";
            return full.StartsWith(project, StringComparison.OrdinalIgnoreCase) ? full.Substring(project.Length) : null;
        }
    }
}
