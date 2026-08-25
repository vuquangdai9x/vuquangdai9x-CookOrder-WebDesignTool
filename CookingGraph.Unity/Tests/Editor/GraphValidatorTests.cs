using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace CookingGraph.Editor.Tests
{
    public sealed class GraphValidatorTests
    {
        [Test]
        public void MinimalRuntimeGraphHasNoErrors()
        {
            var issues = GraphValidator.Validate(GraphJsonDocumentTests.MinimalDocument());
            Assert.That(issues.Where(issue => issue.Severity == GraphIssueSeverity.Error), Is.Empty);
        }

        [Test]
        public void MissingBaseIsAnError()
        {
            var document = GraphJsonDocumentTests.MinimalDocument();
            ((JArray)document.Edges["base"]).Clear();
            Assert.That(GraphValidator.Validate(document).Any(issue => issue.Code == "INV-BASE-REQUIRED"), Is.True);
        }

        [Test]
        public void DuplicateNamespaceAndIdAreErrors()
        {
            var document = GraphJsonDocumentTests.MinimalDocument();
            ((JArray)document.Vertices["group"]).Add(new JObject { ["name"] = "bun", ["displayName"] = "Duplicate" });
            ((JArray)document.IdTable["ingredient"]).Add("bun");
            var issues = GraphValidator.Validate(document);
            Assert.That(issues.Any(issue => issue.Code == "INV-NAMESPACE"), Is.True);
            Assert.That(issues.Any(issue => issue.Code == "INV-IDTABLE-UNIQUE"), Is.True);
        }

        [Test]
        public void GroupMinimumCannotExceedFiniteMaximum()
        {
            var document = GraphJsonDocumentTests.MinimalDocument();
            ((JArray)document.Vertices["group"]).Add(new JObject
            {
                ["name"] = "toppings", ["displayName"] = "Toppings", ["minQuantity"] = 3, ["maxQuantity"] = 2
            });
            ((JArray)document.Edges["option"]).Add(new JObject { ["from"] = "toppings", ["to"] = "bun" });
            Assert.That(GraphValidator.Validate(document).Any(issue => issue.Code == "INV-GROUP-QUANTITY"), Is.True);
        }

        [Test]
        public void DirtyStackMaximumMustBePositive()
        {
            var document = GraphJsonDocumentTests.MinimalDocument();
            ((JArray)document.Vertices["dirty"]).Add(new JObject
            {
                ["name"] = "dirty-plate", ["displayName"] = "Dirty Plate", ["maxStack"] = 0
            });
            Assert.That(GraphValidator.Validate(document).Any(issue => issue.Code == "INV-DIRTY-STACK"), Is.True);
        }

        [Test]
        public void UnobtainableNodeIsAnErrorOnlyWhenAnOrderableReachesIt()
        {
            var unreachable = GraphJsonDocumentTests.MinimalDocument();
            ((JArray)unreachable.Vertices["ingredient"]).Add(new JObject { ["name"] = "donut", ["displayName"] = "Donut" });
            ((JArray)unreachable.Vertices["group"]).Add(new JObject { ["name"] = "leftovers", ["displayName"] = "Leftovers" });
            var leftover = GraphValidator.Validate(unreachable);
            Assert.That(leftover.Where(issue => issue.Severity == GraphIssueSeverity.Error), Is.Empty,
                "unfinished work nothing orders is a leftover, not a broken graph");
            Assert.That(leftover.Count(issue => issue.Code == "WARN-UNUSED-DEAD-NODE"), Is.EqualTo(2));

            var ordered = GraphJsonDocumentTests.MinimalDocument();
            ((JArray)ordered.Vertices["ingredient"]).Add(new JObject { ["name"] = "donut", ["displayName"] = "Donut" });
            ((JArray)ordered.Edges["topping"]).Add(new JObject { ["from"] = "burger", ["to"] = "donut" });
            Assert.That(GraphValidator.Validate(ordered).Any(issue => issue.Code == "INV-UNIQUE-PRODUCER"), Is.True);
        }

        [Test]
        public void PreservationSlotsAndWiringMustAgree()
        {
            var slotsOnly = GraphJsonDocumentTests.MinimalDocument();
            AddGrinder(slotsOnly, 1);
            Assert.That(PreservationErrors(slotsOnly), Is.Not.Empty, "slots with nothing wired can never be entered");

            var edgeOnly = GraphJsonDocumentTests.MinimalDocument();
            AddGrinder(edgeOnly, 0);
            ((JArray)edgeOnly.Edges["preservation"]).Add(new JObject { ["from"] = "grinder", ["to"] = "bun" });
            Assert.That(PreservationErrors(edgeOnly), Is.Not.Empty, "an edge declares a buffer that does not exist");
        }

        [Test]
        public void WiredPreservationBufferIsClean()
        {
            var document = GraphJsonDocumentTests.MinimalDocument();
            AddGrinder(document, 1);
            ((JArray)document.Edges["preservation"]).Add(new JObject { ["from"] = "grinder", ["to"] = "bun" });
            Assert.That(PreservationErrors(document), Is.Empty);
        }

        [Test]
        public void ToolTakesAtMostOnePreservationEdge()
        {
            var document = GraphJsonDocumentTests.MinimalDocument();
            AddGrinder(document, 2);
            ((JArray)document.Vertices["ingredient"]).Add(new JObject { ["name"] = "salt", ["displayName"] = "Salt", ["pickupable"] = true });
            ((JArray)document.Edges["preservation"]).Add(new JObject { ["from"] = "grinder", ["to"] = "bun" });
            ((JArray)document.Edges["preservation"]).Add(new JObject { ["from"] = "grinder", ["to"] = "salt" });
            Assert.That(PreservationErrors(document), Is.Not.Empty);
        }

        [Test]
        public void PreservationCannotPointAtAComposite()
        {
            var document = GraphJsonDocumentTests.MinimalDocument();
            AddGrinder(document, 1);
            ((JArray)document.Edges["preservation"]).Add(new JObject { ["from"] = "grinder", ["to"] = "burger" });
            Assert.That(GraphValidator.Validate(document).Any(issue => issue.Code == "INV-REF"), Is.True);
        }

        private static void AddGrinder(GraphJsonDocument document, int preservationSlots)
        {
            ((JArray)document.Vertices["tool"]).Add(new JObject
            {
                ["name"] = "grinder",
                ["displayName"] = "Grinder",
                ["slotConfigs"] = new JArray(new JObject { ["name"] = "Slot", ["slot"] = 1 }),
                ["preservationSlots"] = preservationSlots,
                ["cookingTime"] = 1
            });
        }

        private static IEnumerable<GraphIssue> PreservationErrors(GraphJsonDocument document)
        {
            return GraphValidator.Validate(document)
                .Where(issue => issue.Severity == GraphIssueSeverity.Error && issue.Message.Contains("preservation"))
                .ToList();
        }

        [Test]
        public void BatchedIntermediateOutputIsAllowed()
        {
            var document = GraphJsonDocumentTests.MinimalDocument();
            ((JArray)document.Vertices["ingredient"]).Add(new JObject
            {
                ["name"] = "sliced-potato", ["displayName"] = "Sliced Potato", ["pickupable"] = false
            });
            ((JArray)document.Edges["process"]).Add(new JObject
            {
                ["from"] = "cutter",
                ["to"] = "sliced-potato",
                ["inputs"] = new JArray(new JObject { ["ingredient"] = "potato", ["slot"] = 0 }),
                ["amount"] = 2
            });

            Assert.That(GraphValidator.Validate(document).Any(issue => issue.Code == "INV-INTERMEDIATE-AMOUNT"), Is.False);
        }
    }
}
