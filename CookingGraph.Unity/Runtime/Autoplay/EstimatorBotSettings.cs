using System;
using UnityEngine;

namespace CookingGraph
{
    /// <summary>Runtime counterparts of the web estimator's default scoring scenario.</summary>
    [Serializable]
    public sealed class EstimatorBotSettings
    {
        [Min(0)] public float scoreBase = 1000;
        [Min(0)] public float scoreReady = 850;
        [Min(0)] public float scoreBlocked = 260;
        [Min(0)] public float scoreBlockedTight = 60;
        [Min(0)] public float scoreSweeper = 500;
        [Min(0)] public float scoreSweeperUrgent = 1400;
        [Range(0, 1)] public float previewConfidence = 0.08f;
        [Min(0)] public float depthBonusPerLevel = 45;
        [Min(0)] public float depthBonusCap = 180;
        [Min(0)] public float multiInputBaseBonus = 260;
        [Min(0)] public float multiInputBonus = 120;
        [Min(0)] public float nearCompletionBonus = 25;
        [Min(0)] public float customerPositionDecay = 0.12f;
        [Min(0)] public float scarcityFactor = 0.2f;
        [Min(0)] public float scarcityCap = 0.45f;
        [Min(0)] public float lastInputBonusMulti = 0.45f;
        [Min(0)] public float lastInputBonusSingle = 0.2f;
        [Range(0, 1)] public float rowDecay = 0.5f;
        [Min(0)] public float detourPenalty = 30;
        [Min(0)] public float detourPenaltyTight = 160;
        [Range(0, 1)] public float gridTightThreshold = 0.5f;

        /// <summary>Zero uses CookingGraphAsset.map.visibleRows.</summary>
        [Min(0)] public int visibleLookaheadRows;
        public bool respectHiddenStatus;
        public int randomSeed = 0x5eed;
    }
}
