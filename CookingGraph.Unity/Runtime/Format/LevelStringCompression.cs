using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;

namespace CookingGraph
{
    /// <summary>Web export v1: z1_ + unpadded Base64url of raw DEFLATE UTF-8 bytes.</summary>
    public static class LevelStringCompression
    {
        public const string Prefix = "z1_";
        public const int MaxDecodedBytes = 1024 * 1024;

        /// <summary>Accepts both compressed exports and existing readable level strings.</summary>
        public static string Decode(string source)
        {
            if (source == null)
                throw new CookingGraphFormatException("Level string is null", 0, string.Empty);
            if (!source.StartsWith(Prefix, StringComparison.Ordinal))
            {
                if (Regex.IsMatch(source, @"^z\d+_"))
                    throw new CookingGraphFormatException("Unsupported level compression version", 0, source);
                return source;
            }

            try
            {
                var payload = source.Substring(Prefix.Length);
                if (!Regex.IsMatch(payload, @"\A[A-Za-z0-9_-]+\z") || payload.Length % 4 == 1)
                    throw new FormatException("Expected unpadded Base64url");
                var base64 = payload.Replace('-', '+').Replace('_', '/');
                base64 = base64.PadRight((base64.Length + 3) / 4 * 4, '=');
                var bytes = Convert.FromBase64String(base64);
                using (var input = new MemoryStream(bytes))
                using (var deflate = new DeflateStream(input, CompressionMode.Decompress))
                using (var output = new MemoryStream())
                {
                    var buffer = new byte[4096];
                    int count;
                    while ((count = deflate.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        if (output.Length + count > MaxDecodedBytes)
                            throw new InvalidDataException("Decoded level exceeds 1 MiB");
                        output.Write(buffer, 0, count);
                    }
                    // Encoder represents an empty source with an empty field, never z1_.
                    if (output.Length == 0) throw new InvalidDataException("Empty compressed level");
                    return new UTF8Encoding(false, true).GetString(output.ToArray());
                }
            }
            catch (Exception error) when (error is FormatException || error is IOException || error is ArgumentException)
            {
                throw new CookingGraphFormatException("Invalid compressed level string: " + error.Message, 0, source);
            }
        }
    }
}
