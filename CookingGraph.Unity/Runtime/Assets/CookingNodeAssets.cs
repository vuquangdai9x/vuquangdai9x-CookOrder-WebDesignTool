using System;

namespace CookingGraph
{
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

}
