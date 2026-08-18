using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.UIElements;

namespace CookingGraph.Editor
{
    internal sealed class GraphCanvasElement : VisualElement
    {
        private const float NodeWidth = 180f;
        private const float NodeHeight = 72f;
        private readonly VisualElement _content;
        private GraphJsonDocument _document;
        private string _selectedKind;
        private string _selectedName;
        private Vector2 _pan = new Vector2(40, 40);
        private float _zoom = 1f;
        private bool _panning;
        private int _panPointer;
        private Vector2 _panStart;
        private Vector2 _panOrigin;

        public Action<string, string> SelectionChanged;
        public Action<string, string, float, float> NodeMoved;
        public Func<string, string, CookingNodeAsset> ResolveGeneratedAsset;

        public GraphCanvasElement()
        {
            focusable = true;
            style.flexGrow = 1;
            style.overflow = Overflow.Hidden;
            style.backgroundColor = new Color(0.12f, 0.13f, 0.15f);
            generateVisualContent += DrawEdges;

            _content = new VisualElement { pickingMode = PickingMode.Ignore };
            _content.style.position = Position.Absolute;
            _content.style.left = 0;
            _content.style.top = 0;
            Add(_content);

            RegisterCallback<WheelEvent>(OnWheel);
            RegisterCallback<PointerDownEvent>(OnPointerDown);
            RegisterCallback<PointerMoveEvent>(OnPointerMove);
            RegisterCallback<PointerUpEvent>(OnPointerUp);
        }

        public void Bind(GraphJsonDocument document, string selectedKind, string selectedName)
        {
            _document = document;
            _selectedKind = selectedKind;
            _selectedName = selectedName;
            Rebuild();
        }

        public void FrameAll()
        {
            _pan = new Vector2(40, 40);
            _zoom = 1f;
            ApplyTransform();
        }

        private void Rebuild()
        {
            _content.Clear();
            if (_document == null) return;
            foreach (var note in _document.Notes.OfType<JObject>())
            {
                var label = new Label(note.Value<string>("text") ?? string.Empty);
                label.pickingMode = PickingMode.Ignore;
                label.style.position = Position.Absolute;
                label.style.left = note.Value<float?>("x") ?? 0;
                label.style.top = note.Value<float?>("y") ?? 0;
                label.style.maxWidth = 220;
                label.style.whiteSpace = WhiteSpace.Normal;
                label.style.paddingLeft = 8;
                label.style.paddingRight = 8;
                label.style.paddingTop = 6;
                label.style.paddingBottom = 6;
                label.style.backgroundColor = new Color(0.45f, 0.38f, 0.12f, 0.92f);
                _content.Add(label);
            }

            foreach (var pair in _document.Nodes()) _content.Add(CreateNode(pair.Kind, pair.Node));
            ApplyTransform();
            MarkDirtyRepaint();
        }

        private VisualElement CreateNode(string kind, JObject node)
        {
            var name = node.Value<string>("name") ?? string.Empty;
            var position = PositionOf(kind, name);
            var root = new VisualElement { name = "node-" + kind + "-" + name, focusable = true };
            root.style.position = Position.Absolute;
            root.style.left = position.x;
            root.style.top = position.y;
            root.style.width = NodeWidth;
            root.style.height = NodeHeight;
            root.style.borderTopWidth = root.style.borderBottomWidth = root.style.borderLeftWidth = root.style.borderRightWidth = 2;
            var color = Color.gray;
            ColorUtility.TryParseHtmlString(GraphSchema.Vertices[kind].Color, out color);
            root.style.borderTopColor = root.style.borderBottomColor = root.style.borderLeftColor = root.style.borderRightColor = color;
            root.style.backgroundColor = new Color(color.r * .25f, color.g * .25f, color.b * .25f, .98f);
            root.style.borderTopLeftRadius = root.style.borderTopRightRadius = root.style.borderBottomLeftRadius = root.style.borderBottomRightRadius = 6;
            root.style.paddingLeft = root.style.paddingRight = 8;
            root.style.paddingTop = root.style.paddingBottom = 5;
            if (_selectedKind == kind && _selectedName == name)
            {
                root.style.borderTopWidth = root.style.borderBottomWidth = root.style.borderLeftWidth = root.style.borderRightWidth = 4;
            }

            var top = new VisualElement();
            top.style.flexDirection = FlexDirection.Row;
            top.style.alignItems = Align.Center;
            var generated = ResolveGeneratedAsset?.Invoke(kind, name);
            if (generated != null && generated.sprite != null)
            {
                var image = new Image { sprite = generated.sprite, scaleMode = ScaleMode.ScaleToFit };
                image.style.width = image.style.height = 30;
                image.style.marginRight = 7;
                top.Add(image);
            }
            else if (!string.IsNullOrEmpty(node.Value<string>("emoji")))
            {
                var emoji = new Label(node.Value<string>("emoji"));
                emoji.style.fontSize = 22;
                emoji.style.marginRight = 7;
                top.Add(emoji);
            }
            var text = new VisualElement();
            text.style.flexGrow = 1;
            var title = new Label(node.Value<string>("displayName") ?? name);
            title.style.unityFontStyleAndWeight = FontStyle.Bold;
            var subtitle = new Label($"{kind} · {name}");
            subtitle.style.fontSize = 10;
            subtitle.style.color = new Color(.75f, .75f, .75f);
            text.Add(title);
            text.Add(subtitle);
            top.Add(text);
            root.Add(top);

            root.RegisterCallback<PointerDownEvent>(evt =>
            {
                if (evt.button != 0) return;
                evt.StopPropagation();
                SelectionChanged?.Invoke(kind, name);
                root.CapturePointer(evt.pointerId);
                root.userData = new DragData
                {
                    PointerId = evt.pointerId,
                    PointerStart = evt.position,
                    NodeStart = new Vector2(root.resolvedStyle.left, root.resolvedStyle.top)
                };
            });
            root.RegisterCallback<PointerMoveEvent>(evt =>
            {
                if (!(root.userData is DragData drag) || drag.PointerId != evt.pointerId || !root.HasPointerCapture(evt.pointerId)) return;
                var pointer = (Vector2)evt.position;
                var delta = (pointer - drag.PointerStart) / _zoom;
                root.style.left = drag.NodeStart.x + delta.x;
                root.style.top = drag.NodeStart.y + delta.y;
                MarkDirtyRepaint();
            });
            root.RegisterCallback<PointerUpEvent>(evt =>
            {
                if (!(root.userData is DragData drag) || drag.PointerId != evt.pointerId) return;
                root.ReleasePointer(evt.pointerId);
                root.userData = null;
                NodeMoved?.Invoke(kind, name, root.resolvedStyle.left, root.resolvedStyle.top);
            });
            return root;
        }

        private void OnWheel(WheelEvent evt)
        {
            var old = _zoom;
            _zoom = Mathf.Clamp(_zoom * (evt.delta.y > 0 ? .9f : 1.1f), .25f, 2.5f);
            var local = evt.localMousePosition;
            _pan = local - (local - _pan) * (_zoom / old);
            ApplyTransform();
            evt.StopPropagation();
        }

        private void OnPointerDown(PointerDownEvent evt)
        {
            if (evt.button != 2 && !(evt.button == 0 && evt.altKey)) return;
            _panning = true;
            _panPointer = evt.pointerId;
            _panStart = evt.position;
            _panOrigin = _pan;
            this.CapturePointer(evt.pointerId);
            evt.StopPropagation();
        }

        private void OnPointerMove(PointerMoveEvent evt)
        {
            if (!_panning || evt.pointerId != _panPointer) return;
            _pan = _panOrigin + (Vector2)evt.position - _panStart;
            ApplyTransform();
        }

        private void OnPointerUp(PointerUpEvent evt)
        {
            if (!_panning || evt.pointerId != _panPointer) return;
            _panning = false;
            this.ReleasePointer(evt.pointerId);
        }

        private void ApplyTransform()
        {
            _content.style.translate = new Translate(_pan.x, _pan.y, 0);
            _content.style.scale = new Scale(new Vector3(_zoom, _zoom, 1));
            MarkDirtyRepaint();
        }

        private void DrawEdges(MeshGenerationContext context)
        {
            if (_document == null) return;
            var painter = context.painter2D;
            painter.lineWidth = 2f;
            foreach (var pair in _document.EdgeRows())
            {
                var fromKind = _document.FindKind(pair.Edge.Value<string>("from"));
                var toKind = _document.FindKind(pair.Edge.Value<string>("to"));
                if (fromKind == null || toKind == null) continue;
                var from = ScreenPoint(PositionOf(fromKind, pair.Edge.Value<string>("from")) + new Vector2(NodeWidth, NodeHeight * .5f));
                var to = ScreenPoint(PositionOf(toKind, pair.Edge.Value<string>("to")) + new Vector2(0, NodeHeight * .5f));
                painter.strokeColor = EdgeColor(pair.Kind);
                painter.BeginPath();
                painter.MoveTo(from);
                var bend = Mathf.Max(35, Mathf.Abs(to.x - from.x) * .45f);
                painter.BezierCurveTo(from + Vector2.right * bend, to - Vector2.right * bend, to);
                painter.Stroke();
            }
        }

        private Vector2 PositionOf(string kind, string name)
        {
            var value = _document?.Layout[$"{kind}:{name}"] as JObject;
            return new Vector2(value?.Value<float?>("x") ?? 40, value?.Value<float?>("y") ?? 40);
        }

        private Vector2 ScreenPoint(Vector2 documentPoint) => _pan + documentPoint * _zoom;

        private static Color EdgeColor(string kind)
        {
            switch (kind)
            {
                case "process": return new Color(.95f, .63f, .25f);
                case "base": return new Color(.25f, .65f, .95f);
                case "topping": return new Color(.75f, .45f, .95f);
                case "option": return new Color(.45f, .85f, .55f);
                default: return new Color(.65f, .65f, .65f);
            }
        }

        private sealed class DragData
        {
            public int PointerId;
            public Vector2 PointerStart;
            public Vector2 NodeStart;
        }
    }
}
