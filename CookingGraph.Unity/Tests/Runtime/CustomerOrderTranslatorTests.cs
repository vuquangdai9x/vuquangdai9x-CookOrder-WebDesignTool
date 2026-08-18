using System.Linq;
using NUnit.Framework;

namespace CookingGraph.Tests
{
    public sealed class CustomerOrderTranslatorTests
    {
        private const string TwoCustomers = "0;60;1;{c0:17.{g0:18.18.19}},{c1:24.8}|0;45;0;{c2:{g1:26}.{g2:14}}";

        [Test]
        public void NestedGraphOrdersRoundTrip()
        {
            var data = CustomerOrderTranslator.Parse(TwoCustomers);
            Assert.That(data.customers, Has.Count.EqualTo(2));
            Assert.That(data.customers[0].dishes, Has.Count.EqualTo(2));
            Assert.That(data.customers[0].dishes[0].root.kind, Is.EqualTo(OrderMemberKind.Composite));
            Assert.That(data.customers[0].dishes[0].root.members[1].kind, Is.EqualTo(OrderMemberKind.Group));
            Assert.That(CustomerOrderTranslator.Serialize(data), Is.EqualTo(TwoCustomers));
        }

        [Test]
        public void StaffAndEffectsRoundTrip()
        {
            const string source = "1;0;0;;3|0;30;0;{c12:117.{g34:234}}#4:1:2";
            var data = CustomerOrderTranslator.Parse(source);
            Assert.That(data.customers[0].hasStaffAmount, Is.True);
            Assert.That(data.customers[0].staffAmount, Is.EqualTo(3));
            Assert.That(data.customers[1].dishes[0].effects[0].parameters, Is.EqualTo(new[] { 1, 2 }));
            Assert.That(CustomerOrderTranslator.Serialize(data), Is.EqualTo(source));
        }

        [Test]
        public void RepetitionPreservesIngredientQuantity()
        {
            var root = CustomerOrderTranslator.Parse("0;0;0;{c0:17.{g0:18.18.19}}").customers[0].dishes[0].root;
            var ids = root.members[1].members.Select(member => member.id).ToArray();
            Assert.That(ids, Is.EqualTo(new[] { 18, 18, 19 }));
        }

        [TestCase("0;0;0;1.0")]
        [TestCase("0;0;0;{g0:1}")]
        [TestCase("0;0;0;{c0:}")]
        [TestCase("0;0;0;{c0:1")]
        [TestCase("0;0")]
        public void LegacyOrMalformedOrdersAreRejected(string source)
        {
            Assert.Throws<CookingGraphFormatException>(() => CustomerOrderTranslator.Parse(source));
        }
    }
}
