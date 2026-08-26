using UnityEditor;
using UnityEngine;

namespace CookingGraph.Editor
{
    [CustomEditor(typeof(CookingNodeAsset), true)]
    [CanEditMultipleObjects]
    public sealed class CookingNodeAssetEditor : UnityEditor.Editor
    {
        private const float PreviewHeightInLines = 4f;

        public override void OnInspectorGUI()
        {
            DrawDefaultInspector();

            SerializedProperty spriteProperty = serializedObject.FindProperty("sprite");
            if (spriteProperty == null || spriteProperty.hasMultipleDifferentValues)
                return;

            Sprite sprite = spriteProperty.objectReferenceValue as Sprite;
            if (sprite == null)
                return;

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Sprite Preview", EditorStyles.boldLabel);

            float previewHeight = EditorGUIUtility.singleLineHeight * PreviewHeightInLines;
            Rect previewRect = EditorGUILayout.GetControlRect(false, previewHeight);
            GUI.Box(previewRect, GUIContent.none, EditorStyles.helpBox);

            Texture2D preview = AssetPreview.GetAssetPreview(sprite);
            if (preview != null)
            {
                GUI.DrawTexture(previewRect, preview, ScaleMode.ScaleToFit, true);
            }
            else if (AssetPreview.IsLoadingAssetPreview(sprite.GetInstanceID()))
            {
                Repaint();
            }
        }
    }
}
