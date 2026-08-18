using System.Collections.Generic;

namespace CookingGraph
{
    public sealed class ToolNodeAsset : CookingNodeAsset
    {
        public List<ToolSlotConfig> slotConfigs = new List<ToolSlotConfig>();
        public float cookingTime;
        public List<int> upgradeCosts = new List<int>();
        public OptionalInt runtimeToolId = new OptionalInt();
    }
}
