using NUnit.Framework;

namespace CookingGraph.Tests
{
    public sealed class LevelStringCompressionTests
    {
        [Test]
        public void WebCustomerExportDecodesAndParsesLosslessly()
        {
            const string source = "0;0;0;{c0:17.{g0:18.18.19}}#4|1;0;0;;3|0;60;1;{c1:24};;2";
            const string packed = "z1_M7AGwepkAytDc73qdCBloQdClrW1yiY1hmBZa-MaA2szA2tDoDpDKyOTWmtrIwA";
            Assert.That(LevelStringCompression.Decode(packed), Is.EqualTo(source));
            Assert.That(CustomerOrderTranslator.Serialize(CustomerOrderTranslator.Parse(packed)), Is.EqualTo(source));
        }

        [Test]
        public void WebQueueExportPreservesEffectsSweepersAndGroups()
        {
            const string source = "-1,1#4:5,0%0,0,1%1,7,1$0-0,1-0;0-1,0-2$1-1,2-1";
            const string packed = "z1_DclBCgAgDAPBx9jeEkiKIuj__9WedmFoeO13oBQEp3HhEOepr3GxwtOiGw";
            Assert.That(LevelStringCompression.Decode(packed), Is.EqualTo(source));
            Assert.That(IngredientQueueTranslator.Serialize(IngredientQueueTranslator.Parse(packed)), Is.EqualTo(source));
        }

        [TestCase("%%")]
        [TestCase("z1_U1UFAA")]
        public void EmptyQueueColumnsSurvive(string source)
        {
            var data = IngredientQueueTranslator.Parse(source);
            Assert.That(data.columns, Has.Count.EqualTo(3));
            Assert.That(IngredientQueueTranslator.Serialize(data), Is.EqualTo("%%"));
        }

        [TestCase("z1_")]
        [TestCase("z1_!")]
        [TestCase("z1_A")]
        [TestCase("z1_AA")]
        [TestCase("z2_abc")]
        public void InvalidExportsProduceStructuredErrors(string source)
        {
            Assert.Throws<CookingGraphFormatException>(() => LevelStringCompression.Decode(source));
            Assert.That(CustomerOrderTranslator.TryParse(source, out _, out _), Is.False);
            Assert.That(IngredientQueueTranslator.TryParse(source, out _, out _), Is.False);
        }

        [TestCase("")]
        [TestCase("0;0;0;{c1:24}")]
        [TestCase("0,1%2,3")]
        public void ReadableStringsStayCompatible(string source)
        {
            Assert.That(LevelStringCompression.Decode(source), Is.EqualTo(source));
        }
    }
}
