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

        private sealed class VerboseLogListener : ICookingBotVerboseLogListener
        {
            public readonly List<CookingBotVerboseLog> entries = new List<CookingBotVerboseLog>();

            public void OnCookingBotVerboseLog(CookingBotVerboseLog entry)
            {
                entries.Add(entry);
            }
        }

        [Test]
        public void VerboseLoggingCanBeEnabledListenedToAndDisabledDuringARun()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("bun", bun));
            state.revision = 12;
            state.gameplayTimeSeconds = 3.5f;
            state.customerOrders.Add(Customer(4, Slot(bun, true, true)));
            var listener = new VerboseLogListener();
            var sink = new Sink();
            var bot = new CookingEstimatorBot(new Reader { state = state }, sink);
            bot.Init(graph);

            Assert.That(listener.entries, Is.Empty, "Verbose logging is disabled by default.");
            bot.SetVerboseLogging(true, listener);
            Assert.That(bot.Tick(), Is.True);

            var accepted = listener.entries.Find(entry => entry.kind == CookingBotVerboseLogKind.PickAccepted);
            Assert.That(accepted, Is.Not.Null);
            Assert.That(accepted.revision, Is.EqualTo(12));
            Assert.That(accepted.gameplayTimeSeconds, Is.EqualTo(3.5f));
            Assert.That(accepted.commandId, Is.EqualTo(1));
            Assert.That(accepted.queueIndex, Is.Zero);
            Assert.That(accepted.itemId, Is.EqualTo("bun"));
            Assert.That(accepted.pendingPickCount, Is.EqualTo(1));

            var countBeforeDisable = listener.entries.Count;
            bot.SetVerboseLogging(false);
            bot.Tick();
            Assert.That(bot.VerboseLoggingEnabled, Is.False);
            Assert.That(listener.entries, Has.Count.EqualTo(countBeforeDisable));

            Destroy(graph, bun, cheese, tomato);
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
            var bot = new CookingEstimatorBot(reader, sink, new EstimatorBotSettings { pickIntervalSeconds = 0 });
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
            state.gameplayTimeSeconds = 1f;

            Assert.That(bot.Tick(), Is.True, "A departing animation must not act as a global bot lock.");
            Assert.That(sink.commands[1].expectedItemId, Is.EqualTo(secondId));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void PacesPicksByGameplayTimeWithoutWaitingForAllAnimations()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("bun", bun), Lane("cheese", cheese));
            state.gameplayTimeSeconds = 10f;
            state.customerOrders.Add(Customer(1, Slot(bun, true, true), Slot(cheese, true, true)));
            var reader = new Reader { state = state };
            var sink = new Sink();
            var bot = new CookingEstimatorBot(reader, sink, new EstimatorBotSettings { pickIntervalSeconds = 0.5f });
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.True);
            var first = sink.commands[0];
            var firstIngredient = first.expectedItemId == "bun" ? bun : cheese;
            state.revision++;
            state.visibleQueues[first.queueIndex].items[0].status = BotQueueItemStatus.Departing;
            state.pickupables.RemoveAll(value => value.itemId == first.expectedItemId);
            state.committedIngredients.Add(new BotCommittedIngredientState
            {
                ingredient = firstIngredient,
                sourceItemId = first.expectedItemId
            });

            state.gameplayTimeSeconds = 10.49f;
            Assert.That(bot.Tick(), Is.False, "The next logical pick must respect the configured cadence.");
            Assert.That(bot.LastDecision, Is.Null);

            state.gameplayTimeSeconds = 10.5f;
            Assert.That(bot.Tick(), Is.True, "The earlier animation may still be running once the cadence expires.");
            Assert.That(sink.commands, Has.Count.EqualTo(2));
            Assert.That(sink.commands[1].pickIntervalSeconds, Is.EqualTo(0.5f));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void WaitForToolAndMergeKeepsTheIntervalAndThenWaitsForLogicalWork()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("bun", bun), Lane("cheese", cheese));
            state.gameplayTimeSeconds = 10f;
            state.customerOrders.Add(Customer(1, Slot(bun, true, true), Slot(cheese, true, true)));
            var sink = new Sink();
            var bot = new CookingEstimatorBot(
                new Reader { state = state },
                sink,
                new EstimatorBotSettings
                {
                    pickIntervalSeconds = 0.5f,
                    workWaitStrategy = CookingBotWorkWaitStrategy.WaitForToolAndMerge
                });
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.True);
            var first = sink.commands[0];
            state.revision++;
            state.visibleQueues[first.queueIndex].items[0].status = BotQueueItemStatus.Departing;
            state.pickupables.RemoveAll(value => value.itemId == first.expectedItemId);
            state.activeToolProcessCount = 1;

            state.gameplayTimeSeconds = 10.49f;
            Assert.That(bot.Tick(), Is.False, "The ordinary cadence remains the first gate.");
            Assert.That(bot.IsWaitingForWorkCompletion, Is.False);

            state.gameplayTimeSeconds = 10.5f;
            Assert.That(bot.Tick(), Is.False, "A progressable tool job keeps the next pick waiting.");
            Assert.That(bot.IsWaitingForWorkCompletion, Is.True);

            state.activeToolProcessCount = 0;
            state.activeMergeAnimationCount = 1;
            Assert.That(bot.Tick(), Is.False, "A logical merge transition is also part of the barrier.");

            state.activeMergeAnimationCount = 0;
            Assert.That(bot.Tick(), Is.True);
            Assert.That(bot.IsWaitingForWorkCompletion, Is.False);
            Assert.That(sink.commands, Has.Count.EqualTo(2));
            Assert.That(sink.commands[1].workWaitStrategy,
                Is.EqualTo(CookingBotWorkWaitStrategy.WaitForToolAndMerge));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void WorkBarrierAllowsOnlyTheMissingCoffeeMachineInput()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var coffeeBean = Node<IngredientNodeAsset>("coffee-bean");
            var groundCoffee = Node<IngredientNodeAsset>("coffee-grinded");
            var cup = Node<IngredientNodeAsset>("cup");
            var coffee = Node<IngredientNodeAsset>("coffee-cup-hot");
            var grinder = Node<ToolNodeAsset>("coffee-grinder");
            var machine = Node<ToolNodeAsset>("coffee-machine");
            graph.ingredients.AddRange(new[] { coffeeBean, groundCoffee, cup, coffee });
            graph.tools.AddRange(new[] { grinder, machine });
            graph.processEdges.Add(new ProcessEdgeAssetData
            {
                from = grinder,
                to = groundCoffee,
                inputs = new List<ProcessInputAssetData>
                {
                    new ProcessInputAssetData { ingredient = coffeeBean, slot = 0 }
                }
            });
            graph.processEdges.Add(new ProcessEdgeAssetData
            {
                from = machine,
                to = coffee,
                inputs = new List<ProcessInputAssetData>
                {
                    new ProcessInputAssetData { ingredient = groundCoffee, slot = 0 },
                    new ProcessInputAssetData { ingredient = cup, slot = 1 }
                }
            });

            var state = State(Lane("coffee-bean", coffeeBean), Lane("unrelated-cheese", cheese));
            state.activeToolProcessCount = 1; // Host incorrectly includes the cup waiting for ground coffee.
            state.committedIngredients.Add(new BotCommittedIngredientState
            {
                ingredient = cup,
                amount = 1,
                sourceItemId = "cup-in-machine"
            });
            state.customerOrders.Add(Customer(1, Slot(coffee, true, true)));
            var listener = new VerboseLogListener();
            var sink = new Sink();
            var bot = new CookingEstimatorBot(
                new Reader { state = state },
                sink,
                new EstimatorBotSettings { workWaitStrategy = CookingBotWorkWaitStrategy.WaitForToolAndMerge });
            bot.Init(graph);
            bot.SetVerboseLogging(true, listener);

            Assert.That(bot.Tick(), Is.True,
                "The coffee bean becomes ground coffee and completes the cup's multi-input recipe.");
            Assert.That(bot.IsWaitingForWorkCompletion, Is.False);
            Assert.That(sink.commands, Has.Count.EqualTo(1));
            Assert.That(sink.commands[0].expectedItemId, Is.EqualTo("coffee-bean"));
            Assert.That(listener.entries.Exists(entry =>
                entry.kind == CookingBotVerboseLogKind.WorkBarrierBypassed), Is.True);

            Destroy(graph, bun, cheese, tomato, coffeeBean, groundCoffee, cup, coffee, grinder, machine);
        }

        [Test]
        public void AdaptiveRetryAndLiveOverrideChangeTheNextTickWorkBarrier()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("bun", bun));
            state.activeToolProcessCount = 1;
            state.customerOrders.Add(Customer(1, Slot(bun, true, true)));
            var knowledge = new CookingBotFailureKnowledge { failureCount = 1 };
            var sink = new Sink();
            var bot = new CookingEstimatorBot(new Reader { state = state }, sink);
            bot.Init(graph, knowledge);

            Assert.That(bot.WorkWaitStrategy, Is.EqualTo(CookingBotWorkWaitStrategy.Adaptive));
            Assert.That(bot.EffectiveWorkWaitStrategy,
                Is.EqualTo(CookingBotWorkWaitStrategy.WaitForToolAndMerge));
            Assert.That(bot.Tick(), Is.False);
            Assert.That(bot.IsWaitingForWorkCompletion, Is.True);

            bot.SetWorkWaitStrategy(CookingBotWorkWaitStrategy.IntervalOnly);
            Assert.That(bot.Tick(), Is.True, "The runtime override must affect the next Tick.");
            Assert.That(bot.EffectiveWorkWaitStrategy,
                Is.EqualTo(CookingBotWorkWaitStrategy.IntervalOnly));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void ChangesPickIntervalDuringARunAndAppliesItToTheCurrentCooldown()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("bun", bun), Lane("cheese", cheese));
            state.gameplayTimeSeconds = 10f;
            state.customerOrders.Add(Customer(1, Slot(bun, true, true), Slot(cheese, true, true)));
            var sink = new Sink();
            var bot = new CookingEstimatorBot(
                new Reader { state = state },
                sink,
                new EstimatorBotSettings { pickIntervalSeconds = 0.5f });
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.True);
            var first = sink.commands[0];
            state.revision++;
            state.visibleQueues[first.queueIndex].items[0].status = BotQueueItemStatus.Departing;
            state.pickupables.RemoveAll(value => value.itemId == first.expectedItemId);

            bot.SetPickIntervalSeconds(0.1f);
            state.gameplayTimeSeconds = 10.09f;
            Assert.That(bot.Tick(), Is.False);
            state.gameplayTimeSeconds = 10.1f;
            Assert.That(bot.Tick(), Is.True);
            Assert.That(bot.PickIntervalSeconds, Is.EqualTo(0.1f));
            Assert.That(sink.commands[1].pickIntervalSeconds, Is.EqualTo(0.1f));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void DefersOnlyCapacityRiskyPickUntilCommittedWorkDrains()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("bun", bun));
            state.grid.cells.RemoveRange(4, 4);
            state.grid.cells[0].kind = BotGridItemKind.Cooked;
            state.grid.cells[1].kind = BotGridItemKind.Raw;
            state.committedIngredients.Add(new BotCommittedIngredientState { ingredient = cheese, amount = 1 });
            state.pickupables[0].footprint = 2;
            state.customerOrders.Add(Customer(1, Slot(bun, true, true)));
            var sink = new Sink();
            var bot = new CookingEstimatorBot(new Reader { state = state }, sink);
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.False);
            Assert.That(bot.IsWaitingForGridCapacity, Is.True);
            Assert.That(bot.LastDecision.projectedGridLoad, Is.EqualTo(5));
            Assert.That(bot.LastDecision.usableGridCapacity, Is.EqualTo(4));
            Assert.That(sink.commands, Is.Empty);

            state.committedIngredients.Clear();
            state.revision++;
            Assert.That(bot.Tick(), Is.True);
            Assert.That(bot.IsWaitingForGridCapacity, Is.False);

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void PicksComplementaryCoffeeInputInsteadOfDeadlockingAtGridCapacity()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var coffeeBean = Node<IngredientNodeAsset>("coffee-bean");
            var groundCoffee = Node<IngredientNodeAsset>("coffee-grinded");
            var cup = Node<IngredientNodeAsset>("cup");
            var coffee = Node<IngredientNodeAsset>("coffee-cup-cool");
            var grinder = Node<ToolNodeAsset>("coffee-grinder");
            var machine = Node<ToolNodeAsset>("coffee-machine");
            graph.ingredients.AddRange(new[] { coffeeBean, groundCoffee, cup, coffee });
            graph.tools.AddRange(new[] { grinder, machine });
            graph.processEdges.Add(new ProcessEdgeAssetData
            {
                from = grinder,
                to = groundCoffee,
                inputs = new List<ProcessInputAssetData>
                {
                    new ProcessInputAssetData { ingredient = coffeeBean, slot = 0 }
                }
            });
            graph.processEdges.Add(new ProcessEdgeAssetData
            {
                from = machine,
                to = coffee,
                inputs = new List<ProcessInputAssetData>
                {
                    new ProcessInputAssetData { ingredient = groundCoffee, slot = 0 },
                    new ProcessInputAssetData { ingredient = cup, slot = 1 }
                }
            });

            var state = State(Lane("cup", cup));
            state.grid.cells.RemoveRange(4, 4);
            state.grid.cells[0].kind = BotGridItemKind.Cooked;
            state.grid.cells[1].kind = BotGridItemKind.Cooked;
            state.grid.cells[2].kind = BotGridItemKind.Dirty;
            state.committedIngredients.Add(new BotCommittedIngredientState
            {
                ingredient = coffeeBean,
                amount = 1,
                sourceItemId = "bean-in-grinder"
            });
            state.customerOrders.Add(Customer(1, Slot(coffee, true, true)));
            var sink = new Sink();
            var bot = new CookingEstimatorBot(new Reader { state = state }, sink);
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.True,
                "Bean and cup combine into one drink, so the legal cup pick must not be deferred as two outputs.");
            Assert.That(bot.IsWaitingForGridCapacity, Is.False);
            Assert.That(bot.LastDecision.projectedGridLoad, Is.EqualTo(4));
            Assert.That(sink.commands[0].expectedItemId, Is.EqualTo("cup"));

            Destroy(graph, bun, cheese, tomato, coffeeBean, groundCoffee, cup, coffee, grinder, machine);
        }

        [Test]
        public void CountsCommittedBatchYieldWhenDecidingWhetherToPickAgain()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var slicedBun = Node<IngredientNodeAsset>("sliced-bun");
            var cutter = Node<ToolNodeAsset>("cutter");
            graph.ingredients.Add(slicedBun);
            graph.tools.Add(cutter);
            graph.processEdges.Add(new ProcessEdgeAssetData
            {
                from = cutter,
                to = slicedBun,
                amount = 3,
                inputs = new List<ProcessInputAssetData>
                {
                    new ProcessInputAssetData { ingredient = bun, slot = 0 }
                }
            });

            var state = State(Lane("cheese", cheese));
            state.grid.cells.RemoveRange(4, 4);
            state.grid.cells[0].kind = BotGridItemKind.Cooked;
            state.committedIngredients.Add(new BotCommittedIngredientState { ingredient = bun, amount = 1 });
            state.customerOrders.Add(Customer(1, Slot(cheese, true, true)));
            var sink = new Sink();
            var bot = new CookingEstimatorBot(new Reader { state = state }, sink);
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.False);
            Assert.That(bot.IsWaitingForGridCapacity, Is.True);
            Assert.That(bot.LastDecision.projectedGridLoad, Is.EqualTo(5));
            Assert.That(sink.commands, Is.Empty);

            Destroy(graph, bun, cheese, tomato, slicedBun, cutter);
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
        public void AdaptiveStrategyUsesRemainingCustomersAndReevaluatesLive()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("bun", bun));
            state.customerOrders.Add(Customer(1, Slot(bun, true, true)));
            state.previewOrders.AddRange(new[]
            {
                new BotPreviewOrderState { customerIndex = 2 },
                new BotPreviewOrderState { customerIndex = 3 },
                new BotPreviewOrderState { customerIndex = 4 }
            });
            state.remainingCustomerCount = 100;
            var bot = new CookingEstimatorBot(new Reader { state = state }, new Sink { accept = false });
            bot.Init(graph);
            bot.SetPickingStrategy(CookingBotPickingStrategy.Adaptive);

            Assert.That(bot.Tick(), Is.False);
            Assert.That(bot.PickingStrategy, Is.EqualTo(CookingBotPickingStrategy.Adaptive));
            Assert.That(bot.EffectivePickingStrategy, Is.EqualTo(CookingBotPickingStrategy.ChainFirst));
            Assert.That(bot.LastDecision.strategyMode, Is.EqualTo(CookingBotPickingStrategy.Adaptive));

            state.remainingCustomerCount = 1;
            bot.SetAdaptiveStrategyPickInterval(1);
            Assert.That(bot.Tick(), Is.False);
            Assert.That(bot.EffectivePickingStrategy, Is.EqualTo(CookingBotPickingStrategy.FinishFirst));

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
                reason = CookingBotFailureReason.OutOfIngredient,
                progress01 = 0.25f
            });

            var retrySink = new Sink { accept = false };
            var retryBot = new CookingEstimatorBot(new Reader { state = state }, retrySink);
            retryBot.Init(graph, knowledge);
            Assert.That(retryBot.Tick(), Is.False);

            Assert.That(knowledge.failureCount, Is.EqualTo(1));
            Assert.That(knowledge.scarcityPressure, Is.GreaterThan(0));
            Assert.That(knowledge.hasRecommendedPickingStrategy, Is.True);
            Assert.That(knowledge.recommendedPickingStrategy,
                Is.EqualTo(CookingBotPickingStrategy.ScarcityFirst));
            Assert.That(knowledge.customerPriorities, Has.Count.EqualTo(1));
            Assert.That(knowledge.customerPriorities[0].customerIndex, Is.EqualTo(1));
            Assert.That(knowledge.customerPriorities[0].ingredientNodeNames, Does.Contain("bun"));
            Assert.That(retryBot.FailureKnowledge, Is.SameAs(knowledge));
            Assert.That(retryBot.PickingStrategy, Is.EqualTo(CookingBotPickingStrategy.ScarcityFirst));
            Assert.That(retryBot.LastDecision.score, Is.GreaterThan(originalScore));

            retryBot.SetPickingStrategy(CookingBotPickingStrategy.FrontLoaded);
            Assert.That(retryBot.PickingStrategy, Is.EqualTo(CookingBotPickingStrategy.FrontLoaded));
            retryBot.Init(graph, knowledge);
            Assert.That(retryBot.PickingStrategy, Is.EqualTo(CookingBotPickingStrategy.ScarcityFirst),
                "Init must replace a live test override with the knowledge recommendation.");

            var restored = JsonUtility.FromJson<CookingBotFailureKnowledge>(JsonUtility.ToJson(knowledge));
            Assert.That(restored.failureCount, Is.EqualTo(knowledge.failureCount));
            Assert.That(restored.urgencyPressure, Is.EqualTo(knowledge.urgencyPressure));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void CustomerTimeoutIsWarningOnlyAndDoesNotChangeFailureKnowledge()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var bot = new CookingEstimatorBot(new Reader { state = State(Lane("bun", bun)) }, new Sink());
            bot.Init(graph);

            var knowledge = bot.AccumulateFailure(new CookingBotFailureReport
            {
                reason = CookingBotFailureReason.CustomerTimeout,
                progress01 = 0.25f
            });

            Assert.That(knowledge.failureCount, Is.Zero);
            Assert.That(knowledge.urgencyPressure, Is.Zero);
            Assert.That(knowledge.pacingPressure, Is.Zero);
            Assert.That(knowledge.hasRecommendedPickingStrategy, Is.False);

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void RetainsExactTimedOutCustomerIdsFromTheFinalStoppedSnapshot()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("bun", bun));
            state.isPlaying = false;
            state.timedOutCustomerIndices.AddRange(new[] { 7, 3, 7 });
            var bot = new CookingEstimatorBot(new Reader { state = state }, new Sink());
            bot.Init(graph);

            Assert.That(bot.Tick(), Is.False);
            Assert.That(bot.TimedOutCustomerIndices, Is.EqualTo(new[] { 3, 7 }));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void GridFailureLearnsASlowerPickCadenceForTheNextRun()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("bun", bun));
            state.committedIngredients.Add(new BotCommittedIngredientState { ingredient = bun, amount = 6 });
            var bot = new CookingEstimatorBot(
                new Reader { state = state },
                new Sink { accept = false },
                new EstimatorBotSettings { pickIntervalSeconds = 0.1f });
            bot.Init(graph);
            bot.Tick();

            var knowledge = bot.AccumulateFailure(new CookingBotFailureReport
            {
                reason = CookingBotFailureReason.GridOverflow,
                progress01 = 0.5f
            });

            Assert.That(knowledge.pacingPressure, Is.GreaterThan(0));
            Assert.That(knowledge.recommendedPickingStrategy,
                Is.EqualTo(CookingBotPickingStrategy.GridSafe));
            Assert.That(bot.PickIntervalSeconds, Is.GreaterThan(0.1f));
            var restored = JsonUtility.FromJson<CookingBotFailureKnowledge>(JsonUtility.ToJson(knowledge));
            Assert.That(restored.pacingPressure, Is.EqualTo(knowledge.pacingPressure));

            Destroy(graph, bun, cheese, tomato);
        }

        [Test]
        public void FallsBackToAdaptiveAfterSimpleStrategiesAndThenTightensItsInterval()
        {
            var graph = Graph(out var bun, out var cheese, out var tomato);
            var state = State(Lane("bun", bun));
            state.customerOrders.Add(Customer(1, Slot(bun, true, true)));
            var knowledge = new CookingBotFailureKnowledge();
            var attempted = new HashSet<CookingBotPickingStrategy>();

            for (var attempt = 0; attempt < 7; attempt++)
            {
                var bot = new CookingEstimatorBot(new Reader { state = state }, new Sink { accept = false });
                bot.Init(graph, knowledge);
                Assert.That(attempted.Add(bot.PickingStrategy), Is.True,
                    "Init must select an untried recommendation rather than repeat a failed strategy.");
                knowledge = bot.AccumulateFailure(new CookingBotFailureReport
                {
                    reason = CookingBotFailureReason.Deadlock,
                    progress01 = 0.5f
                });
            }

            Assert.That(attempted, Has.Count.EqualTo(7));
            Assert.That(knowledge.hasRecommendedPickingStrategy, Is.True);
            Assert.That(knowledge.recommendedPickingStrategy, Is.EqualTo(CookingBotPickingStrategy.Adaptive));
            Assert.That(knowledge.strategySearchExhausted, Is.False);

            for (var adaptiveFailure = 0; adaptiveFailure < 5; adaptiveFailure++)
            {
                var bot = new CookingEstimatorBot(new Reader { state = state }, new Sink { accept = false });
                bot.Init(graph, knowledge);
                Assert.That(bot.PickingStrategy, Is.EqualTo(CookingBotPickingStrategy.Adaptive));
                bot.Tick();
                Assert.That(bot.EffectivePickingStrategy, Is.Not.EqualTo(CookingBotPickingStrategy.Adaptive));
                knowledge = bot.AccumulateFailure(new CookingBotFailureReport
                {
                    reason = CookingBotFailureReason.Deadlock,
                    progress01 = 0.5f
                });
            }

            Assert.That(knowledge.adaptiveStrategyPickInterval, Is.EqualTo(1));
            Assert.That(knowledge.hasRecommendedPickingStrategy, Is.False);
            Assert.That(knowledge.strategySearchExhausted, Is.True);

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
