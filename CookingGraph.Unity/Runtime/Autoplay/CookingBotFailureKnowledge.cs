using System;
using System.Collections.Generic;
using System.Linq;
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
    /// Map-scoped memory captured from an exact active order at failure. Preview-only hidden
    /// ingredient choices are never written here.
    /// </summary>
    [Serializable]
    public sealed class CookingBotCustomerFailureMemory
    {
        public int customerIndex;
        [Min(0)] public int failureCount;
        public List<string> ingredientNodeNames = new List<string>();
    }

    /// <summary>
    /// Serializable lessons learned from earlier failed runs. Queue contents remain private; exact
    /// ingredient names are stored only for customers whose orders were already active and visible.
    /// </summary>
    [Serializable]
    public sealed class CookingBotFailureKnowledge
    {
        public int version = 3;
        [Min(0)] public int failureCount;
        [Range(0, 3)] public float gridPressure;
        [Range(0, 3)] public float dirtyPressure;
        [Range(0, 3)] public float urgencyPressure;
        [Range(0, 3)] public float scarcityPressure;
        [Range(0, 3)] public float chainPressure;
        [Range(0, 3)] public float randomPressure;
        [Range(0, 3)] public float pacingPressure;
        [Min(0)] public int attemptedPickingStrategyMask;
        public bool hasRecommendedPickingStrategy;
        public CookingBotPickingStrategy recommendedPickingStrategy = CookingBotPickingStrategy.Balanced;
        public bool strategySearchExhausted;
        public List<CookingBotCustomerFailureMemory> customerPriorities = new List<CookingBotCustomerFailureMemory>();
        [Min(1)] public int adaptiveStrategyPickInterval = 5;
        [Min(0)] public int adaptiveFailureCount;
        public bool adaptiveStrategyExhausted;

        internal void Accumulate(
            CookingBotFailureReport report,
            float peakGridRatio,
            float peakDirtyRatio,
            float randomPickRatio,
            float peakConcurrentWorkRatio,
            CookingBotPickingStrategy failedStrategy,
            IEnumerable<CookingBotCustomerFailureMemory> failedCustomers)
        {
            if (report == null) throw new ArgumentNullException(nameof(report));
            // Timing warnings are diagnostic only. They must not make the estimator reject a
            // logically solvable level or distort future strategy/cadence learning.
            if (report.reason == CookingBotFailureReason.CustomerTimeout) return;
            version = 3;
            if (failedStrategy == CookingBotPickingStrategy.Adaptive)
            {
                adaptiveFailureCount++;
                if (adaptiveStrategyPickInterval <= 1) adaptiveStrategyExhausted = true;
                else adaptiveStrategyPickInterval--;
            }
            else
            {
                attemptedPickingStrategyMask |= 1 << (int)failedStrategy;
            }
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
            MergeFailedCustomers(failedCustomers);
            RefreshRecommendedStrategy();
        }

        internal void PrepareForNextRun()
        {
            if (version < 3) version = 3;
            if (adaptiveStrategyPickInterval < 1) adaptiveStrategyPickInterval = 5;
            if (customerPriorities == null) customerPriorities = new List<CookingBotCustomerFailureMemory>();
            if (failureCount <= 0)
            {
                hasRecommendedPickingStrategy = false;
                strategySearchExhausted = false;
                return;
            }
            if (!hasRecommendedPickingStrategy && !strategySearchExhausted)
                RefreshRecommendedStrategy();
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

        private void RefreshRecommendedStrategy()
        {
            var candidates = new[]
            {
                CookingBotPickingStrategy.GridSafe,
                CookingBotPickingStrategy.FinishFirst,
                CookingBotPickingStrategy.ScarcityFirst,
                CookingBotPickingStrategy.ChainFirst,
                CookingBotPickingStrategy.FrontLoaded,
                CookingBotPickingStrategy.NoPreview,
                CookingBotPickingStrategy.Balanced
            };
            var found = false;
            var best = CookingBotPickingStrategy.Balanced;
            var bestScore = float.NegativeInfinity;
            foreach (var candidate in candidates)
            {
                if ((attemptedPickingStrategyMask & (1 << (int)candidate)) != 0) continue;
                var score = StrategyScore(candidate);
                if (found && score <= bestScore) continue;
                found = true;
                best = candidate;
                bestScore = score;
            }

            if (found)
            {
                hasRecommendedPickingStrategy = true;
                strategySearchExhausted = false;
                recommendedPickingStrategy = best;
                return;
            }

            hasRecommendedPickingStrategy = !adaptiveStrategyExhausted;
            strategySearchExhausted = adaptiveStrategyExhausted;
            if (!adaptiveStrategyExhausted) recommendedPickingStrategy = CookingBotPickingStrategy.Adaptive;
        }

        private void MergeFailedCustomers(IEnumerable<CookingBotCustomerFailureMemory> failedCustomers)
        {
            if (customerPriorities == null) customerPriorities = new List<CookingBotCustomerFailureMemory>();
            foreach (var failed in failedCustomers ?? Enumerable.Empty<CookingBotCustomerFailureMemory>())
            {
                if (failed == null) continue;
                var existing = customerPriorities.FirstOrDefault(value =>
                    value != null && value.customerIndex == failed.customerIndex);
                if (existing == null)
                {
                    existing = new CookingBotCustomerFailureMemory { customerIndex = failed.customerIndex };
                    customerPriorities.Add(existing);
                }
                existing.failureCount += Math.Max(1, failed.failureCount);
                if (existing.ingredientNodeNames == null) existing.ingredientNodeNames = new List<string>();
                foreach (var name in failed.ingredientNodeNames ?? new List<string>())
                    if (!string.IsNullOrEmpty(name) && !existing.ingredientNodeNames.Contains(name))
                        existing.ingredientNodeNames.Add(name);
            }
            customerPriorities = customerPriorities
                .Where(value => value != null)
                .OrderByDescending(value => value.failureCount)
                .ThenBy(value => value.customerIndex)
                .Take(32)
                .ToList();
        }

        private float StrategyScore(CookingBotPickingStrategy strategy)
        {
            switch (strategy)
            {
                case CookingBotPickingStrategy.GridSafe:
                    return Math.Max(gridPressure, Math.Max(dirtyPressure, pacingPressure));
                case CookingBotPickingStrategy.FinishFirst:
                    return urgencyPressure;
                case CookingBotPickingStrategy.ScarcityFirst:
                    return scarcityPressure;
                case CookingBotPickingStrategy.ChainFirst:
                    return chainPressure;
                case CookingBotPickingStrategy.FrontLoaded:
                    return randomPressure;
                case CookingBotPickingStrategy.NoPreview:
                    return randomPressure * 0.5f + gridPressure * 0.1f;
                case CookingBotPickingStrategy.Balanced:
                    return -0.01f;
                default:
                    return float.NegativeInfinity;
            }
        }
    }
}
