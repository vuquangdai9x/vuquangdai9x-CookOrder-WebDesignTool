using System;

namespace CookingGraph
{
    /// <summary>A strict level-string parse failure with source position and local context.</summary>
    public sealed class CookingGraphFormatException : FormatException
    {
        public int Position { get; }
        public string Context { get; }

        public CookingGraphFormatException(string message, int position, string context)
            : base($"{message} at position {position} in \"{context}\"")
        {
            Position = position;
            Context = context ?? string.Empty;
        }
    }
}
