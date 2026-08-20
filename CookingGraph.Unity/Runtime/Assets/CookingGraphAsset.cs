using System;
using System.Collections.Generic;
using UnityEngine;

namespace CookingGraph
{
    [Serializable]
    public sealed class CookingMapData
    {
        public string id;
        public string name;
        public int gridWidth;
        public int gridHeight;
        public int dirtyStackHeight;
        public int visibleRows;
    }

    [Serializable]
    public sealed class ProcessInputAssetData
    {
        public IngredientNodeAsset ingredient;
        public int slot;
    }

    [Serializable]
    public sealed class ProcessEdgeAssetData
    {
        public ToolNodeAsset from;
        public IngredientNodeAsset to;
        public List<ProcessInputAssetData> inputs = new List<ProcessInputAssetData>();
        public int amount = 1;
        public bool auto = true;
        public OptionalFloat duration = new OptionalFloat();
        public List<ToolNodeAsset> chainTools = new List<ToolNodeAsset>();
    }

    [Serializable]
    public sealed class NodeEdgeAssetData
    {
        public CookingNodeAsset from;
        public CookingNodeAsset to;
    }

    [Serializable]
    public sealed class OptionEdgeAssetData
    {
        public GroupNodeAsset from;
        public CookingNodeAsset to;
        public OptionalInt maxQuantity = new OptionalInt();
    }

    [Serializable]
    public sealed class DirtyEdgeAssetData
    {
        public CompositeNodeAsset from;
        public DirtyNodeAsset to;
    }

    [Serializable]
    public sealed class CookingIdTables
    {
        public List<IngredientNodeAsset> ingredient = new List<IngredientNodeAsset>();
        public List<CompositeNodeAsset> composite = new List<CompositeNodeAsset>();
        public List<GroupNodeAsset> group = new List<GroupNodeAsset>();
        public List<ToolNodeAsset> tool = new List<ToolNodeAsset>();
        public List<DirtyNodeAsset> dirty = new List<DirtyNodeAsset>();
    }

    public sealed class CookingGraphAsset : ScriptableObject
    {
        public int schemaVersion;
        public CookingMapData map = new CookingMapData();
        public CookingIdTables idTable = new CookingIdTables();
        public List<IngredientNodeAsset> ingredients = new List<IngredientNodeAsset>();
        public List<ToolNodeAsset> tools = new List<ToolNodeAsset>();
        public List<GroupNodeAsset> groups = new List<GroupNodeAsset>();
        public List<CompositeNodeAsset> composites = new List<CompositeNodeAsset>();
        public List<DirtyNodeAsset> dirtyObjects = new List<DirtyNodeAsset>();
        public List<ProcessEdgeAssetData> processEdges = new List<ProcessEdgeAssetData>();
        public List<NodeEdgeAssetData> baseEdges = new List<NodeEdgeAssetData>();
        public List<NodeEdgeAssetData> toppingEdges = new List<NodeEdgeAssetData>();
        public List<OptionEdgeAssetData> optionEdges = new List<OptionEdgeAssetData>();
        public List<DirtyEdgeAssetData> leavesDirtyEdges = new List<DirtyEdgeAssetData>();
    }
}
