using System.Collections.Generic;

namespace CookingGraph
{
    public sealed class ToolNodeAsset : CookingNodeAsset
    {
        public List<ToolSlotConfig> slotConfigs = new List<ToolSlotConfig>();

        /// <summary>
        /// Waiting positions outside the recipe layout. A pickup this tool preserves
        /// (see <see cref="CookingGraphAsset.preservationEdges"/>) lands here first, advances into a
        /// free process slot by itself, and is refused while every position is occupied. These
        /// positions never cook.
        /// </summary>
        public int preservationSlots;

        public float cookingTime;
        public List<int> upgradeCosts = new List<int>();
        public OptionalInt runtimeToolId = new OptionalInt();
    }
}
