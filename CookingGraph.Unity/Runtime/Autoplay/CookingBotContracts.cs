using System;
using System.Collections.Generic;

namespace CookingGraph
{
    /// <summary>
    /// Logical status of an item still rendered in a queue. Departing items may remain visible while
    /// their animation runs, but are no longer queue supply and must not be picked again.
    /// </summary>
    public enum BotQueueItemStatus
    {
        Ready,
        Hidden,
        Frozen,
        Locked,
        Departing
    }

    [Serializable]
    public sealed class BotQueueItemState
    {
        /// <summary>Stable id of this item instance. It must not be reused when the queue shifts.</summary>
        public string itemId;
        public QueueItemKind kind;
        public IngredientNodeAsset ingredient;
        public BotQueueItemStatus status;
    }

    [Serializable]
    public sealed class BotQueueLaneState
    {
        /// <summary>Visible items, front first. Hidden ingredients should normally have ingredient = null.</summary>
        public List<BotQueueItemState> items = new List<BotQueueItemState>();
    }

    /// <summary>
    /// One action the authoritative game currently permits. A linked/combined pickup can consume
    /// several rendered items and contribute several ingredients from one queue click.
    /// </summary>
    [Serializable]
    public sealed class BotPickupOption
    {
        public int queueIndex;
        public string itemId;
        public List<string> consumedItemIds = new List<string>();
        public List<IngredientNodeAsset> ingredients = new List<IngredientNodeAsset>();
        public bool picksSweeper;

        /// <summary>
        /// Resulting grid footprint when known. Zero asks the scorer to derive it from recipe yield.
        /// </summary>
        public int footprint;
    }

    public enum BotGridItemKind
    {
        Empty,
        Raw,
        Cooked,
        Dirty,
        Backpack
    }

    [Serializable]
    public sealed class BotGridCellState
    {
        public BotGridItemKind kind;
        /// <summary>False for a logically blocked/locked cell even when it is visually empty.</summary>
        public bool canHoldItem = true;
        public IngredientNodeAsset ingredient;
        public List<IngredientNodeAsset> ingredients = new List<IngredientNodeAsset>();
        public int usesLeft = 1;
        public int dirtyCount;
    }

    [Serializable]
    public sealed class BotGridState
    {
        /// <summary>Every logical grid position, including empty and locked positions.</summary>
        public List<BotGridCellState> cells = new List<BotGridCellState>();
    }

    [Serializable]
    public sealed class BotSaveMeBagItemState
    {
        /// <summary>Stable id for this unit while it remains inside or departs from the bag.</summary>
        public string itemId;
        public IngredientNodeAsset ingredient;
    }

    /// <summary>
    /// Contents of the Save Me backpack. Multi-use cooked items appear once per remaining use,
    /// matching the web simulation. When this object is supplied it is the authoritative source of
    /// bag contents; a Backpack grid cell still represents occupied space but its ingredients list
    /// is ignored to prevent double-counting.
    /// </summary>
    [Serializable]
    public sealed class BotSaveMeBagState
    {
        public string bagId;
        public List<BotSaveMeBagItemState> items = new List<BotSaveMeBagItemState>();
    }

    /// <summary>
    /// Ingredient already owned by the player but not represented by a raw/backpack grid cell.
    /// Include queue-to-tool flights, tool inputs, cooking jobs, and tool-to-grid flights here.
    /// This logical reservation must be created as soon as a pick is accepted, without waiting for
    /// its visual animation to finish.
    /// </summary>
    [Serializable]
    public sealed class BotCommittedIngredientState
    {
        public IngredientNodeAsset ingredient;
        public float amount = 1;
        public string sourceItemId;
    }

    [Serializable]
    public sealed class BotOrderSlotState
    {
        public IngredientNodeAsset ingredient;
        public bool filled;
        public bool isBase;
        public bool gateOpen;
    }

    [Serializable]
    public sealed class BotDishOrderState
    {
        public CompositeNodeAsset orderable;
        public List<BotOrderSlotState> slots = new List<BotOrderSlotState>();
    }

    [Serializable]
    public sealed class BotCustomerOrderState
    {
        public int customerIndex;
        public bool isStaff;
        public List<BotDishOrderState> dishes = new List<BotDishOrderState>();
    }

    /// <summary>
    /// A preview deliberately exposes only dish types. Exact selected toppings stay unknown, as in
    /// the web estimator's low-confidence composite preview.
    /// </summary>
    [Serializable]
    public sealed class BotPreviewOrderState
    {
        public int customerIndex;
        public bool isStaff;
        public List<CompositeNodeAsset> dishes = new List<CompositeNodeAsset>();
    }

    [Serializable]
    public sealed class BotGameState
    {
        /// <summary>Increment after every accepted logical state change, not after animation completion.</summary>
        public long revision;
        public bool isPlaying = true;
        public List<BotQueueLaneState> visibleQueues = new List<BotQueueLaneState>();
        public List<BotPickupOption> pickupables = new List<BotPickupOption>();
        public BotGridState grid = new BotGridState();
        public BotSaveMeBagState saveMeBag;
        public List<BotCommittedIngredientState> committedIngredients = new List<BotCommittedIngredientState>();
        public List<BotCustomerOrderState> customerOrders = new List<BotCustomerOrderState>();
        public List<BotPreviewOrderState> previewOrders = new List<BotPreviewOrderState>();
    }

    /// <summary>Reads one internally consistent, authoritative logical snapshot.</summary>
    public interface ICookingBotStateReader
    {
        BotGameState ReadState();
    }

    [Serializable]
    public sealed class BotPickCommand
    {
        public long commandId;
        public long observedRevision;
        public int queueIndex;
        public string expectedItemId;
        public float score;
        public bool randomFallback;
    }

    /// <summary>
    /// Applies a queue pick to gameplay state. Returning true means the logical pick was committed
    /// synchronously and the next snapshot will have a newer revision. Visual animation may continue.
    /// Return false for a stale revision, a busy/illegal queue, or any rejected command.
    /// </summary>
    public interface ICookingBotCommandSink
    {
        bool TryPick(BotPickCommand command);
    }

    [Serializable]
    public sealed class BotDecision
    {
        public BotPickupOption option;
        public float score;
        public bool randomFallback;
        public int customerIndex = -1;
    }
}
