using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;

namespace CookingGraph.Tests
{
    public sealed class EstimatorBotTests
    {
        private sealed class Reader : ICookingBotStateReader
        {
            public BotGameState state;
            public BotGameState ReadState() => state;
        }

        private sealed class Sink : ICookingBotCommandSink
        {
            public readonly List<BotPickCommand> commands = new List<BotPickCommand>();
            public bool accept = true;
            public bool TryPick(BotPickCommand command)
            {
                commands.Add(command);
                return accept;
            }
        }

        [Test]
        public void PicksReadyBaseBeforeUnrelatedIngredient()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("cheese", cheese), Lane("bun", bun));
            state.customerOrders.Add(Customer(7, Slot(bun, true, true)));
            var reader = new Reader { state = state };
            var sink = new Sink();
            var bot = new CookingEstimatorBot(reader, sink);
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.True);
            Assert.That(sink.commands[0].queueIndex, Is.EqualTo(1));
            Assert.That(sink.commands[0].expectedItemId, Is.EqualTo("bun"));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void UsesVisibleLookaheadToDigTowardDemand()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            graph.map.visibleRows = 2;
            var state = State(
                Lane(
                    new BotQueueItemState { itemId = "cheese", ingredient = cheese, status = BotQueueItemStatus.Ready },
                    new BotQueueItemState { itemId = "bun", ingredient = bun, status = BotQueueItemStatus.Ready }),
                Lane("tomato", tomato));
            state.customerOrders.Add(Customer(3, Slot(bun, true, true)));
            var reader = new Reader { state = state };
            var sink = new Sink();
            var bot = new CookingEstimatorBot(reader, sink);
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.True);
            Assert.That(sink.commands[0].queueIndex, Is.Zero);
            Assert.That(sink.commands[0].expectedItemId, Is.EqualTo("cheese"));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void DoesNotSubmitSameItemTwiceFromAnUnchangedSnapshot()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var reader = new Reader { state = State(Lane("bun", bun), Lane("cheese", cheese)) };
            reader.state.customerOrders.Add(Customer(1, Slot(bun, true, true)));
            var sink = new Sink();
            var bot = new CookingEstimatorBot(reader, sink);
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.True);
            Assert.That(bot.Tick(), Is.True, "Another lane can be submitted while the first snapshot is visually stale.");
            Assert.That(bot.Tick(), Is.False, "Both visible item instances are now reserved.");
            Assert.That(sink.commands, Has.Count.EqualTo(2));
            Assert.That(sink.commands[0].expectedItemId, Is.Not.EqualTo(sink.commands[1].expectedItemId));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void ContinuesPickingWhenEarlierItemIsStillDeparting()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("bun", bun), Lane("cheese", cheese));
            state.customerOrders.Add(Customer(1, Slot(bun, true, true), Slot(cheese, true, true)));
            var reader = new Reader { state = state };
            var sink = new Sink();
            var bot = new CookingEstimatorBot(reader, sink);
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.True);
            var first = sink.commands[0];
            var firstIngredient = first.expectedItemId == "bun" ? bun : cheese;
            var secondId = first.expectedItemId == "bun" ? "cheese" : "bun";
            state.revision++;
            state.visibleQueues[first.queueIndex].items[0].status = BotQueueItemStatus.Departing;
            state.pickupables.RemoveAll(value => value.itemId == first.expectedItemId);
            state.committedIngredients.Add(new BotCommittedIngredientState
            {
                ingredient = firstIngredient,
                sourceItemId = first.expectedItemId
            });

            Assert.That(bot.Tick(), Is.True, "A departing animation must not act as a global bot lock.");
            Assert.That(sink.commands[1].expectedItemId, Is.EqualTo(secondId));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void SaveMeBagContentsSatisfyDemandBeforeAnotherQueuePick()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("queued-bun", bun), Lane("queued-cheese", cheese));
            state.customerOrders.Add(Customer(1, Slot(bun, true, true), Slot(cheese, true, true)));
            state.saveMeBag = new BotSaveMeBagState { bagId = "save-me-bag" };
            state.saveMeBag.items.Add(new BotSaveMeBagItemState
            {
                itemId = "bag-bun-1",
                ingredient = bun
            });
            state.grid.cells[0] = new BotGridCellState { kind = BotGridItemKind.Backpack };
            var reader = new Reader { state = state };
            var sink = new Sink();
            var bot = new CookingEstimatorBot(reader, sink);
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.True);
            Assert.That(sink.commands[0].expectedItemId, Is.EqualTo("queued-cheese"));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void NeverPicksFrozenItemEvenWhenPickupablesAdapterListsIt()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("frozen-bun", bun), Lane("ready-cheese", cheese));
            state.visibleQueues[0].items[0].status = BotQueueItemStatus.Frozen;
            state.customerOrders.Add(Customer(1, Slot(bun, true, true)));
            var reader = new Reader { state = state };
            var sink = new Sink();
            var bot = new CookingEstimatorBot(reader, sink);
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.True);
            Assert.That(sink.commands[0].expectedItemId, Is.EqualTo("ready-cheese"));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void RejectsWholeLinkedPickupWhenAnyMemberIsFrozen()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("linked-bun", bun), Lane("linked-cheese", cheese), Lane("ready-tomato", tomato));
            state.visibleQueues[1].items[0].status = BotQueueItemStatus.Frozen;
            state.pickupables[0].consumedItemIds.AddRange(new[] { "linked-bun", "linked-cheese" });
            state.pickupables[0].ingredients.Add(cheese);
            state.pickupables.RemoveAt(1);
            state.customerOrders.Add(Customer(1, Slot(bun, true, true), Slot(cheese, true, true)));
            var reader = new Reader { state = state };
            var sink = new Sink();
            var bot = new CookingEstimatorBot(reader, sink);
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.True);
            Assert.That(sink.commands[0].expectedItemId, Is.EqualTo("ready-tomato"));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void ChangesPickingStrategyOnNextTickWithoutReinitializing()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("bun", bun));
            state.customerOrders.Add(Customer(1, Slot(bun, true, true)));
            var reader = new Reader { state = state };
            var sink = new Sink { accept = false };
            var bot = new CookingEstimatorBot(reader, sink);
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.False);
            var balancedScore = bot.LastDecision.score;
            bot.SetPickingStrategy(CookingBotPickingStrategy.FrontLoaded);
            Assert.That(bot.Tick(), Is.False);

            Assert.That(bot.IsInitialized, Is.True);
            Assert.That(bot.Graph, Is.SameAs(graph));
            Assert.That(bot.PickingStrategy, Is.EqualTo(CookingBotPickingStrategy.FrontLoaded));
            Assert.That(bot.LastDecision.pickingStrategy, Is.EqualTo(CookingBotPickingStrategy.FrontLoaded));
            Assert.That(bot.LastDecision.score, Is.GreaterThan(balancedScore));
            Assert.That(sink.commands[1].pickingStrategy, Is.EqualTo(CookingBotPickingStrategy.FrontLoaded));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void ChangesIntelligentOnNextTickWithoutAllowingFrozenItems()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("frozen-bun", bun), Lane("ready-cheese", cheese));
            state.visibleQueues[0].items[0].status = BotQueueItemStatus.Frozen;
            state.customerOrders.Add(Customer(1, Slot(bun, true, true)));
            var reader = new Reader { state = state };
            var sink = new Sink { accept = false };
            var bot = new CookingEstimatorBot(reader, sink);
            bot.Init(graph);

            bot.SetIntelligent(0f);
            Assert.That(bot.Tick(), Is.False);

            Assert.That(bot.Intelligent, Is.Zero);
            Assert.That(bot.LastDecision.randomFallback, Is.True);
            Assert.That(bot.LastDecision.intelligent, Is.Zero);
            Assert.That(sink.commands[0].intelligent, Is.Zero);
            Assert.That(sink.commands[0].expectedItemId, Is.EqualTo("ready-cheese"));

            bot.SetIntelligent(2f);
            Assert.That(bot.Intelligent, Is.EqualTo(1f), "Runtime values are clamped to the documented range.");

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void AccumulatesFailureKnowledgeAndAppliesItOnNextInit()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("bun", bun));
            state.customerOrders.Add(Customer(1, Slot(bun, true, true)));
            var firstReader = new Reader { state = state };
            var firstSink = new Sink { accept = false };
            var firstBot = new CookingEstimatorBot(firstReader, firstSink);
            firstBot.Init(graph);

            Assert.That(firstBot.Tick(), Is.False);
            var originalScore = firstBot.LastDecision.score;
            var knowledge = firstBot.AccumulateFailure(new CookingBotFailureReport
            {
                reason = CookingBotFailureReason.CustomerTimeout,
                progress01 = 0.25f
            });

            var retrySink = new Sink { accept = false };
            var retryBot = new CookingEstimatorBot(new Reader { state = state }, retrySink);
            retryBot.Init(graph, knowledge);
            Assert.That(retryBot.Tick(), Is.False);

            Assert.That(knowledge.failureCount, Is.EqualTo(1));
            Assert.That(knowledge.urgencyPressure, Is.GreaterThan(0));
            Assert.That(retryBot.FailureKnowledge, Is.SameAs(knowledge));
            Assert.That(retryBot.LastDecision.score, Is.GreaterThan(originalScore));

            var restored = JsonUtility.FromJson<CookingBotFailureKnowledge>(JsonUtility.ToJson(knowledge));
            Assert.That(restored.failureCount, Is.EqualTo(knowledge.failureCount));
            Assert.That(restored.urgencyPressure, Is.EqualTo(knowledge.urgencyPressure));

            Destroy(graph, bun, cheese, tomato);
        }

        private static CookingGraphAsset Graph(out IngredientNodeAsset bun, out IngredientNodeAsset cheese, out IngredientNodeAsset tomato)
        {
            var graph = ScriptableObject.CreateInstance<CookingGraphAsset>();
            graph.map.visibleRows = 1;
            bun = Node<IngredientNodeAsset>("bun");
            cheese = Node<IngredientNodeAsset>("cheese");
            tomato = Node<IngredientNodeAsset>("tomato");
            graph.ingredients.AddRange(new[] { bun, cheese, tomato });
            return graph;
        }

        private static BotGameState State(params BotQueueLaneState[] lanes)
        {
            var state = new BotGameState { revision = 1 };
            state.visibleQueues.AddRange(lanes);
            for (var index = 0; index < lanes.Length; index++)
            {
                var item = lanes[index].items[0];
                state.pickupables.Add(new BotPickupOption
                {
                    queueIndex = index,
                    itemId = item.itemId,
                    ingredients = new List<IngredientNodeAsset> { item.ingredient }
                });
            }
            for (var index = 0; index < 8; index++) state.grid.cells.Add(new BotGridCellState());
            return state;
        }

        private static BotQueueLaneState Lane(string id, IngredientNodeAsset ingredient)
        {
            return Lane(new BotQueueItemState { itemId = id, ingredient = ingredient, status = BotQueueItemStatus.Ready });
        }

        private static BotQueueLaneState Lane(params BotQueueItemState[] items)
        {
            var lane = new BotQueueLaneState();
            lane.items.AddRange(items);
            return lane;
        }

        private static BotCustomerOrderState Customer(int index, params BotOrderSlotState[] slots)
        {
            var customer = new BotCustomerOrderState { customerIndex = index };
            var dish = new BotDishOrderState();
            dish.slots.AddRange(slots);
            customer.dishes.Add(dish);
            return customer;
        }

        private static BotOrderSlotState Slot(IngredientNodeAsset ingredient, bool isBase, bool gateOpen)
        {
            return new BotOrderSlotState { ingredient = ingredient, isBase = isBase, gateOpen = gateOpen };
        }

        private static T Node<T>(string name) where T : CookingNodeAsset
        {
            var value = ScriptableObject.CreateInstance<T>();
            value.nodeName = name;
            value.displayName = name;
            return value;
        }

        private static void Destroy(params Object[] values)
        {
            foreach (var value in values) Object.DestroyImmediate(value);
        }
    }
}
