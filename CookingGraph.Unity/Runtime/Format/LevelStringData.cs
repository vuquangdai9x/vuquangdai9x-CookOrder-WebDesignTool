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

    #region Prep Grid
    /// <summary>
    /// Cell-type ids a grid string carries. The behaviour behind each one lives in the simulation
    /// (GAMEPLAY_RULES.md §14.2) and depends on live counters, so this enum only names the ids —
    /// it exists so a scene does not carry magic numbers.
    /// </summary>
    public enum CellStatusId
    {
        Normal = 0,
        Blocked = 1,
        OrderLock = 2,
        IngredientSlot = 3,
        ColorLock = 4
    }

    /// <summary>One prep-grid cell. No effects at all is a plain blank cell.</summary>
    [Serializable]
    public sealed class GridCellData
    {
        public List<EffectData> effects = new List<EffectData>();

        public bool IsBlank => effects == null || effects.Count == 0;

        public bool Has(CellStatusId status)
        {
            if (effects == null) return false;
            foreach (var effect in effects)
                if (effect != null && effect.effectId == (int)status) return true;
            return false;
        }
    }

    /// <summary>
    /// The prep grid, in scan order: left to right, top to bottom. Width and height are -1 until the
    /// layout is parsed against a graph, because the string itself carries only a flat cell run.
    /// </summary>
    [Serializable]
    public sealed class GridLayoutData
    {
        public List<GridCellData> cells = new List<GridCellData>();
        public int width = -1;
        public int height = -1;

        public bool HasDimensions => width > 0 && height > 0;

        /// <summary>Scan-order index of a coordinate, or -1 when it is unknown or off the grid.</summary>
        public int IndexOf(int x, int y)
        {
            if (!HasDimensions || x < 0 || y < 0 || x >= width || y >= height) return -1;
            return y * width + x;
        }

        public GridCellData CellAt(int x, int y)
        {
            var index = IndexOf(x, y);
            return index >= 0 && index < cells.Count ? cells[index] : null;
        }
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
        public bool hasCustomerIndex;
        public int customerIndex;
        /// <summary>Resolved from customerIndex via the customerIds lookup passed to Parse, when one is given. Empty when unresolved — gameplay treats an empty id as random.</summary>
        public string customerId = string.Empty;
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
