using System;
using System.Collections.Generic;

namespace CookingGraph
{
    #region Ingredient Queue
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
        /// <summary>Raw numeric token retained for lossless serialization.</summary>
        public int id;
        /// <summary>Position in CookingGraphAsset.idTable.ingredient, or -1 for a sweeper.</summary>
        public int index = -1;
        /// <summary>Resolved ingredient asset when parsed with a CookingGraphAsset.</summary>
        public IngredientNodeAsset ingredient;
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
    #endregion

    #region Customer Order
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
        /// <summary>Raw numeric token retained for lossless serialization.</summary>
        public int id;
        /// <summary>Position in the id table selected by kind.</summary>
        public int index = -1;
        /// <summary>Resolved IngredientNodeAsset, CompositeNodeAsset, or GroupNodeAsset.</summary>
        public CookingNodeAsset asset;
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
    #endregion
}
