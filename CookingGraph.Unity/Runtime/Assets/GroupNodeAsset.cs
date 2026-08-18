using UnityEngine;

namespace CookingGraph
{
    public sealed class GroupNodeAsset : CookingNodeAsset
    {
        [Min(0)] public int minQuantity;
        public OptionalInt maxQuantity = new OptionalInt();
    }
}
