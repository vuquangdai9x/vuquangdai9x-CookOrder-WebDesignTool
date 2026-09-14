namespace CookingGraph
{
    public sealed class IngredientNodeAsset : CookingNodeAsset
    {
        public bool pickupable;
        public int usageNum = 1;
        /// <summary>Smallest bag (pieces per queue slot) Auto Generate uses for this ingredient.</summary>
        public int stackMin = 1;
        /// <summary>Largest bag Auto Generate may put in one queue slot; never below stackMin.</summary>
        public int stackMax = 1;
        public int price;
        public string code;
    }
}
