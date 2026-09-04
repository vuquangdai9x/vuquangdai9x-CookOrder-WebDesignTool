using System;
using UnityEngine;

namespace CookingGraph
{
    public enum CookingBotFailureReason
    {
        Unknown,
        GridOverflow,
        DirtyOverflow,
        CustomerTimeout,
        OutOfIngredient,
        Deadlock,
        IterationLimit
    }

    [Serializable]
    public sealed class CookingBotFailureReport
    {
        public CookingBotFailureReason reason;

        /// <summary>Fraction of the level completed, or -1 when the game does not provide it.</summary>
        [Range(-1, 1)] public float progress01 = -1f;
    }

    /// <summary>
    /// Serializable lessons learned from earlier failed runs. Only aggregate pressures are stored;
    /// there are deliberately no ingredient, queue, item, or customer identities.
    /// </summary>
    [Serializable]
    public sealed class CookingBotFailureKnowledge
    {
        public int version = 1;
        [Min(0)] public int failureCount;
        [Range(0, 3)] public float gridPressure;
        [Range(0, 3)] public float dirtyPressure;
        [Range(0, 3)] public float urgencyPressure;
        [Range(0, 3)] public float scarcityPressure;
        [Range(0, 3)] public float chainPressure;
        [Range(0, 3)] public float randomPressure;
        [Range(0, 3)] public float pacingPressure;

        internal void Accumulate(
            CookingBotFailureReport report,
            float peakGridRatio,
            float peakDirtyRatio,
            float randomPickRatio,
            float peakConcurrentWorkRatio)
        {
            if (report == null) throw new ArgumentNullException(nameof(report));
            // Timing warnings are diagnostic only. They must not make the estimator reject a
            // logically solvable level or distort future strategy/cadence learning.
            if (report.reason == CookingBotFailureReason.CustomerTimeout) return;
            const float retain = 0.85f;
            var unfinished = report.progress01 >= 0 ? 1f - Clamp(report.progress01, 0, 1) : 0;
            var gridDelta = (report.reason == CookingBotFailureReason.GridOverflow ? 1f : 0f) +
                            Math.Max(0, peakGridRatio - 0.7f);
            var dirtyDelta = (report.reason == CookingBotFailureReason.DirtyOverflow ? 1f : 0f) +
                             Math.Max(0, peakDirtyRatio - 0.35f);
            var urgencyDelta = unfinished * 0.1f;
            var scarcityDelta = (report.reason == CookingBotFailureReason.OutOfIngredient ? 1f : 0f) +
                                (report.reason == CookingBotFailureReason.Deadlock ? 0.2f : 0f);
            var chainDelta = (report.reason == CookingBotFailureReason.Deadlock ? 1f : 0f) +
                             (report.reason == CookingBotFailureReason.OutOfIngredient ? 0.15f : 0f);
            var pacingDelta = (report.reason == CookingBotFailureReason.GridOverflow ||
                               report.reason == CookingBotFailureReason.DirtyOverflow
                    ? 0.75f
                    : 0f) +
                Math.Max(0, peakConcurrentWorkRatio - 0.25f);

            failureCount++;
            gridPressure = Pressure(gridPressure, gridDelta, retain);
            dirtyPressure = Pressure(dirtyPressure, dirtyDelta, retain);
            urgencyPressure = Pressure(urgencyPressure, urgencyDelta, retain);
            scarcityPressure = Pressure(scarcityPressure, scarcityDelta, retain);
            chainPressure = Pressure(chainPressure, chainDelta, retain);
            randomPressure = Pressure(randomPressure, Clamp(randomPickRatio, 0, 1), retain);
            pacingPressure = Pressure(pacingPressure, pacingDelta, retain);
        }

        internal void ApplyTo(EstimatorBotSettings settings)
        {
            if (settings == null) throw new ArgumentNullException(nameof(settings));
            if (failureCount <= 0) return;

            settings.scoreBlocked *= Clamp(1 - gridPressure * 0.18f, 0.25f, 1);
            settings.scoreBlockedTight *= Clamp(1 - gridPressure * 0.25f, 0.1f, 1);
            settings.previewConfidence = Clamp(
                settings.previewConfidence * Clamp(1 - gridPressure * 0.16f, 0.2f, 1),
                0,
                1);
            settings.detourPenalty *= 1 + gridPressure * 0.3f + randomPressure * 0.1f;
            settings.detourPenaltyTight *= 1 + gridPressure * 0.45f + dirtyPressure * 0.15f;
            settings.gridTightThreshold = Clamp(settings.gridTightThreshold + gridPressure * 0.05f, 0, 0.85f);
            settings.pickIntervalSeconds = Clamp(
                settings.pickIntervalSeconds + 0.35f * ((float)Math.Pow(2, pacingPressure) - 1),
                0,
                5);

            settings.scoreSweeper *= 1 + dirtyPressure * 0.35f;
            settings.scoreSweeperUrgent *= 1 + dirtyPressure * 0.65f;

            settings.scoreBase *= 1 + urgencyPressure * 0.08f;
            settings.scoreReady *= 1 + urgencyPressure * 0.25f;
            settings.nearCompletionBonus *= 1 + urgencyPressure * 0.5f;
            settings.customerPositionDecay *= 1 + urgencyPressure * 0.2f;

            settings.scarcityFactor *= 1 + scarcityPressure * 0.55f;
            settings.scarcityCap *= 1 + scarcityPressure * 0.4f;

            settings.depthBonusPerLevel *= 1 + chainPressure * 0.2f;
            settings.multiInputBaseBonus *= 1 + chainPressure * 0.25f;
            settings.multiInputBonus *= 1 + chainPressure * 0.2f;
            settings.lastInputBonusMulti *= 1 + chainPressure * 0.45f;
            settings.lastInputBonusSingle *= 1 + chainPressure * 0.3f;

            settings.rowDecay = Clamp(
                settings.rowDecay + (1 - settings.rowDecay) * Clamp(randomPressure * 0.15f, 0, 0.45f),
                0,
                1);
        }

        private static float Pressure(float current, float delta, float retain)
        {
            return Clamp(current * retain + delta, 0, 3);
        }

        private static float Clamp(float value, float min, float max)
        {
            return Math.Max(min, Math.Min(max, value));
        }
    }
}
