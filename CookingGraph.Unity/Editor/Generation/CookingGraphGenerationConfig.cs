using System;
using UnityEngine;

namespace CookingGraph.Editor
{
    [CreateAssetMenu(fileName = "CookingGraphGenerationConfig", menuName = "Cooking Graph/Generation Config")]
    public sealed class CookingGraphGenerationConfig : ScriptableObject
    {
        [Tooltip("Value substituted for {0} in Output Folder Format.")]
        public int mapIndex;

        [Tooltip("Project-relative folder. {0} is mapIndex and {1} is the sanitized map id.")]
        public string outputFolderFormat = "Assets/_Production/Map-{1}/Graph";

        public string ResolveOutputFolder(string mapId)
        {
            return GenerationPath.Resolve(outputFolderFormat, mapIndex, mapId);
        }
    }

    internal static class GenerationPath
    {
        internal const string DefaultFormat = "Assets/_Production/Map-{1}/Graph";

        internal static string Resolve(string format, int mapIndex, string mapId)
        {
            var template = string.IsNullOrWhiteSpace(format) ? DefaultFormat : format.Trim();
            string path;
            try
            {
                path = string.Format(template, mapIndex, SafePart(mapId));
            }
            catch (FormatException exception)
            {
                throw new InvalidOperationException("Output folder format must use valid {0} and {1} placeholders.", exception);
            }

            path = path.Replace('\\', '/').TrimEnd('/');
            while (path.Contains("//")) path = path.Replace("//", "/");
            if (!path.Equals("Assets", StringComparison.Ordinal) && !path.StartsWith("Assets/", StringComparison.Ordinal))
                throw new InvalidOperationException("Generated assets must be placed in an Assets/ project folder.");
            if (path.Split('/').Length < 2)
                throw new InvalidOperationException("Output folder must name a folder below Assets/.");
            if (Array.Exists(path.Split('/'), part => part == "." || part == ".."))
                throw new InvalidOperationException("Output folder cannot contain '.' or '..' path segments.");
            return path;
        }

        internal static string SafePart(string value)
        {
            var source = string.IsNullOrWhiteSpace(value) ? "map" : value;
            var chars = source.ToCharArray();
            for (var index = 0; index < chars.Length; index++)
                if (!(char.IsLetterOrDigit(chars[index]) || chars[index] == '.' || chars[index] == '_' || chars[index] == '-')) chars[index] = '-';
            var safe = new string(chars).Trim('-');
            return string.IsNullOrEmpty(safe) ? "map" : safe;
        }
    }
}
