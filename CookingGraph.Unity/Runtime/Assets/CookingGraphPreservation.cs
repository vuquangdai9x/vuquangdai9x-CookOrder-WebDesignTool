using System.Collections.Generic;

namespace CookingGraph
{
    /// <summary>
    /// Resolves a graph's preservation edges into the two lookups a runtime actually needs:
    /// which concrete ingredients a tool's buffer accepts, and which tools accept a given
    /// ingredient.
    ///
    /// A preservation edge may point at a GROUP rather than an ingredient, so the accepted set is
    /// the group's concrete options — expanded recursively, since an option can itself be a group
    /// or a composite. Doing that expansion here keeps every consumer (gameplay, tooling, tests)
    /// from re-deriving it, and from disagreeing about it.
    ///
    /// Mirrors <c>preservationIngredients</c> / <c>preservationToolsForInput</c> in the web tool's
    /// <c>core/nodeIndex.ts</c>. See GAMEPLAY_RULES.md §9.5.
    /// </summary>
    public static class CookingGraphPreservation
    {
        /// <summary>
        /// Concrete ingredients <paramref name="tool"/>'s preservation buffer accepts, in graph
        /// order. Empty when the tool has no preservation edge — which is the common case, and is
        /// not an error.
        /// </summary>
        public static List<IngredientNodeAsset> IngredientsFor(CookingGraphAsset graph, ToolNodeAsset tool)
        {
            var result = new List<IngredientNodeAsset>();
            if (graph == null || tool == null) return result;
            var seen = new HashSet<IngredientNodeAsset>();
            foreach (var edge in graph.preservationEdges)
            {
                if (edge?.from != tool) continue;
                Collect(graph, edge.to, result, seen, new HashSet<CookingNodeAsset>());
            }
            return result;
        }

        /// <summary>
        /// Tools whose preservation buffer accepts <paramref name="ingredient"/>, in graph order.
        /// A pickup is offered to them in this order, and takes the first with a free position.
        /// </summary>
        public static List<ToolNodeAsset> ToolsFor(CookingGraphAsset graph, IngredientNodeAsset ingredient)
        {
            var result = new List<ToolNodeAsset>();
            if (graph == null || ingredient == null) return result;
            foreach (var edge in graph.preservationEdges)
            {
                if (edge?.from == null || result.Contains(edge.from)) continue;
                if (IngredientsFor(graph, edge.from).Contains(ingredient)) result.Add(edge.from);
            }
            return result;
        }

        /// <summary>Every tool's accepted set at once, for a runtime that indexes this up front.</summary>
        public static Dictionary<ToolNodeAsset, List<IngredientNodeAsset>> BuildLookup(CookingGraphAsset graph)
        {
            var lookup = new Dictionary<ToolNodeAsset, List<IngredientNodeAsset>>();
            if (graph == null) return lookup;
            foreach (var tool in graph.tools)
            {
                if (tool == null || lookup.ContainsKey(tool)) continue;
                var ingredients = IngredientsFor(graph, tool);
                if (ingredients.Count > 0) lookup.Add(tool, ingredients);
            }
            return lookup;
        }

        // `visiting` guards against a cyclic group/composite wiring: INV-ACYCLIC reports that as an
        // error, but resolving has to stay total on data a designer is halfway through editing.
        private static void Collect(
            CookingGraphAsset graph,
            CookingNodeAsset node,
            ICollection<IngredientNodeAsset> result,
            ISet<IngredientNodeAsset> seen,
            ISet<CookingNodeAsset> visiting)
        {
            if (node == null || !visiting.Add(node)) return;

            switch (node)
            {
                case IngredientNodeAsset ingredient:
                    if (seen.Add(ingredient)) result.Add(ingredient);
                    break;
                case GroupNodeAsset group:
                    foreach (var option in graph.optionEdges)
                        if (option?.from == group) Collect(graph, option.to, result, seen, visiting);
                    break;
                case CompositeNodeAsset composite:
                    foreach (var edge in graph.baseEdges)
                        if (edge?.from == composite) Collect(graph, edge.to, result, seen, visiting);
                    foreach (var edge in graph.toppingEdges)
                        if (edge?.from == composite) Collect(graph, edge.to, result, seen, visiting);
                    break;
            }

            visiting.Remove(node);
        }
    }
}
