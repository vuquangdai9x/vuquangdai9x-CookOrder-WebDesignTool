using System;
using System.Collections.Generic;
using UnityEngine;

namespace CookingGraph.Editor
{
    [Serializable]
    internal sealed class GeneratedNodeMapping
    {
        public string kind;
        public string nodeName;
        public int dataId = -1;
        public string fingerprint;
        public CookingNodeAsset asset;
    }

    internal sealed class CookingGraphEditorData : ScriptableObject
    {
        public string sourcePath;
        public string sourceGuid;
        public string sourceHash;
        public int mapIndex;
        public string outputFolderFormat;
        [TextArea(4, 20)] public string layoutJson;
        [TextArea(4, 20)] public string notesJson;
        [TextArea(4, 20)] public string previousIdTablesJson;
        [TextArea(4, 20)] public string previousDocumentJson;
        public CookingGraphAsset runtimeGraph;
        public List<GeneratedNodeMapping> activeNodes = new List<GeneratedNodeMapping>();
        public List<GeneratedNodeMapping> orphanedNodes = new List<GeneratedNodeMapping>();
    }
}
