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
}
