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
    }
}
