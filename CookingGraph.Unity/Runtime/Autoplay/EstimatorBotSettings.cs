using System;
using UnityEngine;

namespace CookingGraph
{
    /// <summary>Predefined online picking profiles derived from the web estimator retries.</summary>
    public enum CookingBotPickingStrategy
    {
        Balanced,
        GridSafe,
        FrontLoaded,
        FinishFirst,
        ChainFirst,
        ScarcityFirst,
        NoPreview,
        /// <summary>Periodically selects the best simple profile from the current visible state.</summary>
        Adaptive
    }

    /// <summary>Controls whether the cadence may overlap logical tool and merge work.</summary>
    public enum CookingBotWorkWaitStrategy
    {
        /// <summary>
        /// The first run uses interval pacing. A retry initialized with accumulated failure
        /// knowledge waits for tool processing and merge transitions to settle.
        /// </summary>
        Adaptive,

        /// <summary>Use only pickIntervalSeconds and the projected-capacity safety gate.</summary>
        IntervalOnly,

        /// <summary>
        /// After the interval, wait until all progressable tool work and logical merge transitions
        /// are complete before issuing another pick.
        /// </summary>
        WaitForToolAndMerge
    }

    /// <summary>Runtime counterparts of the web estimator's default scoring scenario.</summary>
    [Serializable]
    public sealed class EstimatorBotSettings
    {
        /// <summary>
        /// Probability that a Tick uses the configured strategy. Zero is fully random among legal
        /// pickups; one always uses estimator scoring. Can be changed at runtime through the bot.
        /// </summary>
        [Range(0, 1)] public float intelligent = 1f;
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

        /// <summary>
        /// Minimum gameplay seconds between accepted picks. Cooking and unrelated animations may
        /// continue during the interval; this is pacing, not a global animation lock.
        /// </summary>
        [Min(0)] public float pickIntervalSeconds = 1f;

        /// <summary>Accepted picks between adaptive profile re-evaluations.</summary>
        [Min(1)] public int adaptiveStrategyPickInterval = 5;

        /// <summary>
        /// Additional synchronization applied after the pick interval. Adaptive mirrors the web
        /// estimator: overlap on the first run, then settle tool/merge work on learned retries.
        /// </summary>
        public CookingBotWorkWaitStrategy workWaitStrategy = CookingBotWorkWaitStrategy.Adaptive;

        /// <summary>Zero uses CookingGraphAsset.map.visibleRows.</summary>
        [Min(0)] public int visibleLookaheadRows;
        public bool respectHiddenStatus;
        public int randomSeed = 0x5eed;

        /// <summary>Returns a separate settings instance tuned for one predefined strategy.</summary>
        public EstimatorBotSettings ForStrategy(CookingBotPickingStrategy strategy)
        {
            var tuned = (EstimatorBotSettings)MemberwiseClone();
            switch (strategy)
            {
                case CookingBotPickingStrategy.Balanced:
                    break;
                case CookingBotPickingStrategy.GridSafe:
                    tuned.previewConfidence *= 0.25f;
                    tuned.scoreBlocked *= 0.3f;
                    tuned.scoreBlockedTight = 0;
                    tuned.rowDecay *= 0.55f;
                    tuned.detourPenalty *= 1.6f;
                    tuned.detourPenaltyTight *= 1.6f;
                    tuned.gridTightThreshold = Math.Max(tuned.gridTightThreshold, 0.68f);
                    break;
                case CookingBotPickingStrategy.FrontLoaded:
                    tuned.previewConfidence *= 0.15f;
                    tuned.scoreBase *= 1.15f;
                    tuned.scoreReady *= 1.2f;
                    tuned.scoreBlocked *= 0.25f;
                    tuned.rowDecay *= 0.3f;
                    tuned.detourPenalty *= 1.35f;
                    break;
                case CookingBotPickingStrategy.FinishFirst:
                    tuned.previewConfidence *= 0.2f;
                    tuned.scoreReady *= 1.45f;
                    tuned.scoreBlocked *= 0.3f;
                    tuned.scoreBlockedTight = 0;
                    tuned.nearCompletionBonus *= 3;
                    tuned.rowDecay *= 0.6f;
                    break;
                case CookingBotPickingStrategy.ChainFirst:
                    tuned.previewConfidence *= 0.35f;
                    tuned.scoreBlocked *= 0.55f;
                    tuned.depthBonusPerLevel *= 1.75f;
                    tuned.multiInputBaseBonus *= 1.6f;
                    tuned.multiInputBonus *= 1.4f;
                    tuned.rowDecay *= 0.7f;
                    break;
                case CookingBotPickingStrategy.ScarcityFirst:
                    tuned.previewConfidence *= 0.25f;
                    tuned.scarcityFactor = Math.Max(tuned.scarcityFactor, 0.75f);
                    tuned.scarcityCap = Math.Max(tuned.scarcityCap, 1.4f);
                    tuned.rowDecay *= 0.65f;
                    break;
                case CookingBotPickingStrategy.NoPreview:
                    tuned.previewConfidence = 0;
                    tuned.scoreBlocked *= 0.45f;
                    tuned.scoreBlockedTight *= 0.25f;
                    tuned.rowDecay *= 0.5f;
                    break;
                case CookingBotPickingStrategy.Adaptive:
                    // Adaptive is a mode, not a weight set. The bot replaces it with an effective
                    // simple profile before scoring; Balanced is the safe standalone fallback.
                    break;
                default:
                    throw new ArgumentOutOfRangeException(nameof(strategy), strategy, null);
            }
            return tuned;
        }
    }
}
