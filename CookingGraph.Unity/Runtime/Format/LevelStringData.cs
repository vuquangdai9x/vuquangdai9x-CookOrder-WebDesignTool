using System;
using System.Collections.Generic;

namespace CookingGraph
{
    [Serializable]
    public sealed class EffectData
    {
        public int effectId;
        public List<int> parameters = new List<int>();
    }

    public enum QueueItemKind
    {
        Ingredient,
        Sweeper
    }

    [Serializable]
    public sealed class QueueItemData
    {
        public QueueItemKind kind;
        public int id;
        public List<EffectData> effects = new List<EffectData>();
    }

    [Serializable]
    public sealed class IngredientQueueColumnData
    {
        public List<QueueItemData> items = new List<QueueItemData>();
    }

    public enum QueueGroupKind
    {
        Combined,
        Linked
    }

    [Serializable]
    public sealed class QueueCellData
    {
        public int x;
        public int y;
    }

    [Serializable]
    public sealed class QueueGroupData
    {
        public QueueGroupKind kind;
        public List<QueueCellData> cells = new List<QueueCellData>();
    }

    [Serializable]
    public sealed class IngredientQueueData
    {
        public List<IngredientQueueColumnData> columns = new List<IngredientQueueColumnData>();
        public List<QueueGroupData> groups = new List<QueueGroupData>();
    }

    public enum OrderMemberKind
    {
        Ingredient,
        Composite,
        Group
    }

    /// <summary>A recursive member in the graph customer grammar.</summary>
    [Serializable]
    public sealed class OrderMemberData
    {
        public OrderMemberKind kind;
        public int id;
        public List<OrderMemberData> members = new List<OrderMemberData>();
    }

    [Serializable]
    public sealed class DishOrderData
    {
        public OrderMemberData root;
        public List<EffectData> effects = new List<EffectData>();
    }

    [Serializable]
    public sealed class CustomerData
    {
        public int typeId;
        public int waitTime;
        public int weatherEffect;
        public List<DishOrderData> dishes = new List<DishOrderData>();
        public bool hasStaffAmount;
        public int staffAmount;
    }

    [Serializable]
    public sealed class CustomerOrderData
    {
        public List<CustomerData> customers = new List<CustomerData>();
    }

    [Serializable]
    public sealed class CustomerOrderValidationIssue
    {
        public string code;
        public int customerIndex;
        public int dishIndex;
        public int groupId;
        public int minimum;
        public int maximum = -1;
        public int actual;
        public string message;
    }
}
