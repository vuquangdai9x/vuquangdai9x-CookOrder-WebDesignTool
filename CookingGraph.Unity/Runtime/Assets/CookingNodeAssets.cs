using System;
using System.Collections.Generic;
using UnityEngine;

namespace CookingGraph
{
    public abstract class CookingNodeAsset : ScriptableObject
    {
        public string nodeName;
        public string displayName;
        public string emoji;
        public Sprite sprite;
    }

    [Serializable]
    public sealed class OptionalInt
    {
        public bool hasValue;
        public int value;
    }

    [Serializable]
    public sealed class OptionalFloat
    {
        public bool hasValue;
        public float value;
    }

    [Serializable]
    public sealed class ToolSlotConfig
    {
        public string name;
        public int slot = 1;
    }

    public sealed class IngredientNodeAsset : CookingNodeAsset
    {
        public bool pickupable;
        public bool servable;
        public int usageNum = 1;
        public int price;
        public string code;
    }

    public sealed class ToolNodeAsset : CookingNodeAsset
    {
        public List<ToolSlotConfig> slotConfigs = new List<ToolSlotConfig>();
        public float cookingTime;
        public List<int> upgradeCosts = new List<int>();
        public OptionalInt runtimeToolId = new OptionalInt();
    }

    public sealed class GroupNodeAsset : CookingNodeAsset
    {
        [Min(0)] public int minQuantity;
        public OptionalInt maxQuantity = new OptionalInt();
    }

    public sealed class CompositeNodeAsset : CookingNodeAsset
    {
        public bool orderable;
        public bool toppingRequired;
    }

    public sealed class DirtyNodeAsset : CookingNodeAsset
    {
        public OptionalInt runtimeDirtyId = new OptionalInt();
    }
}
