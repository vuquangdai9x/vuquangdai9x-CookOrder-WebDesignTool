namespace CookingGraph
{
    public sealed class DirtyNodeAsset : CookingNodeAsset
    {
        /// <summary>Per-type stack capacity; when absent, use CookingGraphAsset.map.dirtyStackHeight.</summary>
        public OptionalInt maxStack = new OptionalInt();
        public OptionalInt runtimeDirtyId = new OptionalInt();
    }
}
