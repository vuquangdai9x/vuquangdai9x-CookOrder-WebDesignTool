using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace CookingGraph
{
    public static class CustomerOrderTranslator
    {
        private sealed class Cursor
        {
            public int Index;
        }

        public static CustomerOrderData Parse(string source)
        {
            if (source == null)
                throw new CookingGraphFormatException("Customer string is null", 0, string.Empty);
            var result = new CustomerOrderData();
            if (string.IsNullOrWhiteSpace(source)) return result;

            foreach (var customerToken in source.Split(new[] { '|' }, StringSplitOptions.None))
            {
                var fields = customerToken.Split(new[] { ';' }, StringSplitOptions.None);
                if (fields.Length != 4 && fields.Length != 5)
                    Fail($"Customer must have 4 or 5 semicolon-separated fields, got {fields.Length}", source, source.IndexOf(customerToken, StringComparison.Ordinal));
                var customer = new CustomerData
                {
                    typeId = ParseInt(fields[0], source),
                    waitTime = ParseInt(fields[1], source),
                    weatherEffect = ParseInt(fields[2], source)
                };
                if (!string.IsNullOrEmpty(fields[3]))
                    customer.dishes.AddRange(SplitDishes(fields[3], source).Select(token => ParseDish(token, source)));
                if (fields.Length == 5)
                {
                    customer.hasStaffAmount = true;
                    customer.staffAmount = ParseInt(fields[4], source);
                }
                result.customers.Add(customer);
            }
            return result;
        }

        public static bool TryParse(string source, out CustomerOrderData data, out CookingGraphFormatException error)
        {
            try
            {
                data = Parse(source);
                error = null;
                return true;
            }
            catch (CookingGraphFormatException exception)
            {
                data = null;
                error = exception;
                return false;
            }
        }

        public static string Serialize(CustomerOrderData data)
        {
            if (data == null) throw new ArgumentNullException(nameof(data));
            return string.Join("|", data.customers.Select(customer =>
            {
                var fields = new List<string>
                {
                    customer.typeId.ToString(CultureInfo.InvariantCulture),
                    customer.waitTime.ToString(CultureInfo.InvariantCulture),
                    customer.weatherEffect.ToString(CultureInfo.InvariantCulture),
                    string.Join(",", customer.dishes.Select(SerializeDish))
                };
                if (customer.hasStaffAmount) fields.Add(customer.staffAmount.ToString(CultureInfo.InvariantCulture));
                return string.Join(";", fields);
            }));
        }

        private static DishOrderData ParseDish(string token, string context)
        {
            var hash = token.IndexOf('#');
            var nodePart = hash < 0 ? token : token.Substring(0, hash);
            var effectsPart = hash < 0 ? string.Empty : token.Substring(hash);
            var cursor = new Cursor();
            var root = ParseNode(nodePart, cursor, token);
            if (cursor.Index != nodePart.Length)
                Fail($"Unexpected trailing \"{nodePart.Substring(cursor.Index)}\"", context, Math.Max(0, context.IndexOf(token, StringComparison.Ordinal)) + cursor.Index);
            if (root.kind != OrderMemberKind.Composite)
                Fail("A dish's outermost bracket must be a composite", context, Math.Max(0, context.IndexOf(token, StringComparison.Ordinal)));
            var effects = effectsPart.Length == 0
                ? new List<EffectData>()
                : IngredientQueueTranslator.ParseEffectToken("x" + effectsPart, context).Effects;
            return new DishOrderData { root = root, effects = effects };
        }

        private static OrderMemberData ParseNode(string source, Cursor cursor, string context)
        {
            if (cursor.Index >= source.Length || source[cursor.Index] != '{')
                Fail("Expected '{'", context, cursor.Index);
            cursor.Index++;
            if (cursor.Index >= source.Length || (source[cursor.Index] != 'c' && source[cursor.Index] != 'g'))
                Fail("Expected 'c' or 'g' after '{'", context, cursor.Index);
            var kind = source[cursor.Index++] == 'c' ? OrderMemberKind.Composite : OrderMemberKind.Group;
            var idStart = cursor.Index;
            while (cursor.Index < source.Length && char.IsDigit(source[cursor.Index])) cursor.Index++;
            if (cursor.Index == idStart) Fail("Expected an id after node kind", context, cursor.Index);
            var id = ParseInt(source.Substring(idStart, cursor.Index - idStart), context);
            if (cursor.Index >= source.Length || source[cursor.Index] != ':')
                Fail("Expected ':' after node id", context, cursor.Index);
            cursor.Index++;

            var node = new OrderMemberData { kind = kind, id = id };
            while (true)
            {
                if (cursor.Index >= source.Length) Fail("Expected a member", context, cursor.Index);
                if (source[cursor.Index] == '{')
                {
                    node.members.Add(ParseNode(source, cursor, context));
                }
                else
                {
                    var memberStart = cursor.Index;
                    while (cursor.Index < source.Length && char.IsDigit(source[cursor.Index])) cursor.Index++;
                    if (cursor.Index == memberStart) Fail("Expected an ingredient id or '{'", context, cursor.Index);
                    node.members.Add(new OrderMemberData
                    {
                        kind = OrderMemberKind.Ingredient,
                        id = ParseInt(source.Substring(memberStart, cursor.Index - memberStart), context)
                    });
                }
                if (cursor.Index < source.Length && source[cursor.Index] == '.')
                {
                    cursor.Index++;
                    continue;
                }
                break;
            }
            if (cursor.Index >= source.Length || source[cursor.Index] != '}')
                Fail("Expected '}' or '.'", context, cursor.Index);
            cursor.Index++;
            return node;
        }

        private static IEnumerable<string> SplitDishes(string source, string context)
        {
            var depth = 0;
            var start = 0;
            for (var i = 0; i < source.Length; i++)
            {
                if (source[i] == '{') depth++;
                else if (source[i] == '}') depth--;
                else if (source[i] == ',' && depth == 0)
                {
                    yield return source.Substring(start, i - start);
                    start = i + 1;
                }
                if (depth < 0) Fail("Unexpected '}'", context, i);
            }
            if (depth != 0) Fail("Unbalanced dish brackets", context, source.Length);
            yield return source.Substring(start);
        }

        private static string SerializeDish(DishOrderData dish)
        {
            if (dish?.root == null) throw new ArgumentException("Dish root cannot be null.", nameof(dish));
            if (dish.root.kind != OrderMemberKind.Composite) throw new ArgumentException("Dish root must be a composite.", nameof(dish));
            return SerializeMember(dish.root) + IngredientQueueTranslator.SerializeEffects(dish.effects);
        }

        private static string SerializeMember(OrderMemberData member)
        {
            if (member.kind == OrderMemberKind.Ingredient)
                return member.id.ToString(CultureInfo.InvariantCulture);
            var builder = new StringBuilder();
            builder.Append('{').Append(member.kind == OrderMemberKind.Composite ? 'c' : 'g').Append(member.id).Append(':');
            builder.Append(string.Join(".", member.members.Select(SerializeMember)));
            return builder.Append('}').ToString();
        }

        private static int ParseInt(string token, string context)
        {
            return IngredientQueueTranslator.ParseInteger(token, context, Math.Max(0, context.IndexOf(token, StringComparison.Ordinal)));
        }

        private static void Fail(string message, string context, int position)
        {
            throw new CookingGraphFormatException(message, Math.Max(0, position), context);
        }
    }
}
