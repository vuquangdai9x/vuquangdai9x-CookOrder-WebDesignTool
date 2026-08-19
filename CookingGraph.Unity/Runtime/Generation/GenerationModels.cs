using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace CookingGraph
{
    [Serializable]
    public sealed class GenerationCurveKeyframe
    {
        [Range(0, 1)] public float x;
        [Range(0, 1)] public float y = 0.5f;
        public float tangent;
    }

    [Serializable]
    public sealed class GenerationCurveRange
    {
        public float minX;
        public float maxX = 1;
        public float minY = 1;
        public float maxY = 5;
    }

    /// <summary>The same normalized keyframe/range representation used by the web curve editor.</summary>
    [Serializable]
    public sealed class GenerationCurve
    {
        public GenerationCurveRange range = new GenerationCurveRange();
        public List<GenerationCurveKeyframe> keyframes = new List<GenerationCurveKeyframe>
        {
            new GenerationCurveKeyframe { x = 0, y = 0.5f },
            new GenerationCurveKeyframe { x = 1, y = 0.5f }
        };

        public float Evaluate(float realX)
        {
            var curveRange = range ?? new GenerationCurveRange();
            var frames = (keyframes ?? new List<GenerationCurveKeyframe>()).Where(value => value != null).OrderBy(value => value.x).ToList();
            var normalizedX = Math.Abs(curveRange.maxX - curveRange.minX) < float.Epsilon
                ? 0
                : Clamp01((realX - curveRange.minX) / (curveRange.maxX - curveRange.minX));
            var normalizedY = Clamp01(EvaluateNormalized(frames, normalizedX));
            return curveRange.minY + normalizedY * (curveRange.maxY - curveRange.minY);
        }

        private static float EvaluateNormalized(IReadOnlyList<GenerationCurveKeyframe> frames, float x)
        {
            if (frames.Count == 0) return 0.5f;
            if (x <= frames[0].x) return frames[0].y;
            var last = frames[frames.Count - 1];
            if (x >= last.x) return last.y;
            for (var i = 0; i < frames.Count - 1; i++)
            {
                var a = frames[i];
                var b = frames[i + 1];
                if (x < a.x || x > b.x) continue;
                var dx = b.x - a.x;
                var p1x = a.x + dx / 3;
                var p1y = a.y + a.tangent * dx / 3;
                var p2x = b.x - dx / 3;
                var p2y = b.y - b.tangent * dx / 3;
                var low = 0f;
                var high = 1f;
                for (var iteration = 0; iteration < 40; iteration++)
                {
                    var t = (low + high) / 2;
                    if (Cubic(a.x, p1x, p2x, b.x, t) < x) low = t;
                    else high = t;
                }
                return Cubic(a.y, p1y, p2y, b.y, (low + high) / 2);
            }
            return last.y;
        }

        private static float Cubic(float p0, float p1, float p2, float p3, float t)
        {
            var inverse = 1 - t;
            return inverse * inverse * inverse * p0 + 3 * inverse * inverse * t * p1 + 3 * inverse * t * t * p2 + t * t * t * p3;
        }

        private static float Clamp01(float value) => Math.Max(0, Math.Min(1, value));
    }

    [Serializable]
    public sealed class IngredientGenerationWeight
    {
        /// <summary>Preferred stable reference.</summary>
        public IngredientNodeAsset ingredient;
        /// <summary>Fallback index in CookingGraphAsset.ingredients, matching the web generator's dense ingredient index.</summary>
        public int index = -1;
        [Min(0)] public float weight;
    }

    [Serializable]
    public sealed class CustomerOrderGenerationOptions
    {
        /// <summary>-1 = staff, 0 = auto dish count, positive = explicit dish count.</summary>
        public List<int> dishCounts = new List<int> { 1 };
        public List<IngredientGenerationWeight> weights = new List<IngredientGenerationWeight>();
        public GenerationCurve curve = new GenerationCurve();
        [Min(1)] public int maxDishSlots = 5;
    }

    public enum QueueShuffleKind
    {
        Fixed,
        Curve
    }

    [Serializable]
    public sealed class QueueShuffleRange
    {
        public QueueShuffleKind kind;
        [Min(0)] public int value;
        public GenerationCurve curve = new GenerationCurve
        {
            range = new GenerationCurveRange { minX = 0, maxX = 1, minY = 0, maxY = 0 }
        };
    }
}
