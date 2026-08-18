using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.UIElements;
using UnityEngine;
using UnityEngine.UIElements;

namespace CookingGraph.Editor
{
    internal sealed class GraphUndoState : ScriptableObject
    {
        [TextArea(10, 30)] public string json;
    }

    public sealed class CookingGraphEditorWindow : EditorWindow
    {
        [SerializeField] private CookingGraphGenerationConfig _generationConfig;
        private GraphJsonDocument _document;
        private GraphUndoState _undoState;
        private GraphCanvasElement _canvas;
        private ScrollView _side;
        private Label _status;
        private Button _generateButton;
        private string _sourcePath;
        private string _savedJson;
        private string _selectedKind;
        private string _selectedName;
        private bool _readOnly;
        private IReadOnlyList<GraphIssue> _issues = Array.Empty<GraphIssue>();

        [MenuItem("Window/Cooking Graph/Node Editor")]
        public static void OpenWindow()
        {
            var window = GetWindow<CookingGraphEditorWindow>();
            window.titleContent = new GUIContent("Cooking Graph");
            window.minSize = new Vector2(920, 560);
            window.Show();
        }

        private void OnEnable()
        {
            if (_undoState == null)
            {
                _undoState = CreateInstance<GraphUndoState>();
                _undoState.hideFlags = HideFlags.HideAndDontSave;
            }
            Undo.undoRedoPerformed += OnUndoRedo;
        }

        private void OnDisable()
        {
            Undo.undoRedoPerformed -= OnUndoRedo;
        }

        public void CreateGUI()
        {
            rootVisualElement.Clear();
            rootVisualElement.style.flexDirection = FlexDirection.Column;
            rootVisualElement.RegisterCallback<KeyDownEvent>(OnKeyDown);
            BuildToolbar();

            if (_document == null)
            {
                var empty = new VisualElement();
                empty.style.flexGrow = 1;
                empty.style.alignItems = Align.Center;
                empty.style.justifyContent = Justify.Center;
                empty.Add(new Label("Import a CookOrder graph JSON document to begin."));
                var import = new Button(ImportJson) { text = "Import JSON…" };
                import.style.marginTop = 12;
                empty.Add(import);
                rootVisualElement.Add(empty);
                BuildStatus();
                return;
            }

            var split = new TwoPaneSplitView(1, 380, TwoPaneSplitViewOrientation.Horizontal);
            split.style.flexGrow = 1;
            _canvas = new GraphCanvasElement
            {
                SelectionChanged = SelectNode,
                NodeMoved = (kind, name, x, y) => Mutate("Move node", () =>
                    _document.Layout[$"{kind}:{name}"] = new JObject { ["x"] = x, ["y"] = y }),
                ResolveGeneratedAsset = ResolveGeneratedAsset
            };
            split.Add(_canvas);
            _side = new ScrollView(ScrollViewMode.Vertical);
            _side.style.minWidth = 300;
            split.Add(_side);
            rootVisualElement.Add(split);
            BuildStatus();
            Refresh();
        }

        public override void SaveChanges()
        {
            if (SaveJson()) base.SaveChanges();
        }

        public override void DiscardChanges()
        {
            hasUnsavedChanges = false;
            base.DiscardChanges();
        }

        private void BuildToolbar()
        {
            var bar = new Toolbar();
            bar.Add(new ToolbarButton(ImportJson) { text = "Import" });
            bar.Add(new ToolbarButton(() => SaveJson()) { text = "Save" });
            bar.Add(new ToolbarButton(ExportJson) { text = "Export" });
            bar.Add(new ToolbarSpacer());
            bar.Add(new ToolbarButton(() => Undo.PerformUndo()) { text = "Undo" });
            bar.Add(new ToolbarButton(() => Undo.PerformRedo()) { text = "Redo" });
            bar.Add(new ToolbarButton(ShowAddNodeMenu) { text = "Add Node" });
            bar.Add(new ToolbarButton(AutoLayout) { text = "Auto Layout" });
            bar.Add(new ToolbarButton(() => _canvas?.FrameAll()) { text = "Frame All" });
            var configField = new ObjectField("Output Config") { objectType = typeof(CookingGraphGenerationConfig), value = _generationConfig };
            configField.tooltip = "Optional generation config. Create one with Assets > Create > Cooking Graph > Generation Config. {0} is mapIndex; {1} is mapId.";
            configField.style.width = 170;
            configField.RegisterValueChangedCallback(evt =>
            {
                _generationConfig = evt.newValue as CookingGraphGenerationConfig;
                Refresh();
            });
            bar.Add(configField);
            _generateButton = new Button(GenerateOrSync) { text = "Generate Asset" };
            _generateButton.style.marginLeft = 8;
            bar.Add(_generateButton);
            rootVisualElement.Add(bar);
        }

        private void BuildStatus()
        {
            _status = new Label();
            _status.style.paddingLeft = 8;
            _status.style.paddingRight = 8;
            _status.style.height = 22;
            _status.style.unityTextAlign = TextAnchor.MiddleLeft;
            rootVisualElement.Add(_status);
            UpdateStatus();
        }

        private void Refresh()
        {
            if (_document == null) return;
            _issues = GraphValidator.Validate(_document);
            if (_selectedName != null && _document.FindNode(_selectedKind, _selectedName) == null)
            {
                _selectedKind = null;
                _selectedName = null;
            }
            _canvas?.Bind(_document, _selectedKind, _selectedName);
            BuildSidePanel();
            if (_generateButton != null)
            {
                try
                {
                    _generateButton.text = GraphAssetSynchronizer.HasGeneratedAssets(_document.MapId, _generationConfig) ? "Sync" : "Generate Asset";
                    _generateButton.tooltip = _generationConfig?.ResolveOutputFolder(_document.MapId)
                                              ?? GraphAssetSynchronizer.OutputRoot(_document.MapId);
                    _generateButton.SetEnabled(!_readOnly && !_issues.Any(issue => issue.Severity == GraphIssueSeverity.Error));
                }
                catch (Exception exception)
                {
                    _generateButton.text = "Invalid Output Config";
                    _generateButton.tooltip = exception.Message;
                    _generateButton.SetEnabled(false);
                }
            }
            UpdateStatus();
        }

        private void UpdateStatus(string temporary = null)
        {
            if (_status == null) return;
            if (temporary != null)
            {
                _status.text = temporary;
                return;
            }
            if (_document == null)
            {
                _status.text = "No graph loaded";
                return;
            }
            var errors = _issues.Count(issue => issue.Severity == GraphIssueSeverity.Error);
            var warnings = _issues.Count(issue => issue.Severity == GraphIssueSeverity.Warning);
            var mode = _readOnly ? "read-only unsupported schema" : hasUnsavedChanges ? "unsaved" : "saved";
            _status.text = $"{Path.GetFileName(_sourcePath) ?? _document.MapId} · {_document.VertexCount} nodes · {errors} errors · {warnings} warnings · {mode}";
        }

        private void BuildSidePanel()
        {
            if (_side == null) return;
            _side.Clear();
            _side.Add(MapInspector());
            if (_selectedName != null) _side.Add(NodeInspector());
            else _side.Add(HelpBox("Select a node on the canvas to edit it.", HelpBoxMessageType.Info));
            _side.Add(IdTableInspector());
            _side.Add(NotesInspector());
            _side.Add(IssuesInspector());
        }

        private VisualElement MapInspector()
        {
            var foldout = new Foldout { text = "Map", value = false };
            foreach (var field in GraphSchema.MapFields) foldout.Add(FieldEditor(_document.Map, field, "Edit map " + field.Name));
            return foldout;
        }

        private VisualElement NodeInspector()
        {
            var node = _document.FindNode(_selectedKind, _selectedName);
            var root = new Foldout { text = $"{GraphSchema.Vertices[_selectedKind].Label}: {_selectedName}", value = true };
            if (node == null) return root;
            foreach (var field in GraphSchema.Vertices[_selectedKind].Fields)
            {
                if (field.Name == "name") root.Add(NameEditor(node));
                else root.Add(FieldEditor(node, field, $"Edit {_selectedName}.{field.Name}"));
            }

            var generated = ResolveGeneratedAsset(_selectedKind, _selectedName);
            var sprite = new ObjectField("Runtime Sprite") { objectType = typeof(Sprite), value = generated?.sprite };
            sprite.SetEnabled(generated != null);
            sprite.tooltip = generated == null ? "Generate assets first; sprites are assigned on generated node assets." : "Editor-only assignment; not written to JSON.";
            sprite.RegisterValueChangedCallback(evt =>
            {
                if (generated == null) return;
                Undo.RecordObject(generated, "Assign node sprite");
                generated.sprite = evt.newValue as Sprite;
                EditorUtility.SetDirty(generated);
                _canvas.Bind(_document, _selectedKind, _selectedName);
            });
            root.Add(sprite);

            root.Add(EdgeInspector());
            var buttons = new VisualElement();
            buttons.style.flexDirection = FlexDirection.Row;
            buttons.Add(new Button(() =>
            {
                var next = GraphMutation.DuplicateNode(_document, _selectedKind, _selectedName);
                if (next == null) return;
                CommitCurrent("Duplicate node");
                _selectedName = next.Value<string>("name");
                Refresh();
            }) { text = "Duplicate" });
            buttons.Add(new Button(DeleteSelectedNode) { text = "Delete" });
            root.Add(buttons);
            return root;
        }

        private VisualElement NameEditor(JObject node)
        {
            var field = new TextField("name") { value = node.Value<string>("name") ?? string.Empty, isDelayed = true };
            field.SetEnabled(!_readOnly);
            field.RegisterValueChangedCallback(evt =>
            {
                var next = evt.newValue.Trim();
                if (next == _selectedName) return;
                var old = _selectedName;
                Mutate("Rename node", () =>
                {
                    if (!GraphMutation.RenameNode(_document, _selectedKind, old, next)) throw new InvalidOperationException("Node names must be non-empty and graph-unique.");
                    _selectedName = next;
                });
            });
            return field;
        }

        private VisualElement FieldEditor(JObject owner, GraphFieldDefinition definition, string action)
        {
            var row = new VisualElement();
            row.style.marginBottom = 3;
            var token = owner[definition.Name];
            switch (definition.Type)
            {
                case "bool":
                    var toggle = new Toggle(definition.Name) { value = token?.Value<bool>() ?? Convert.ToBoolean(definition.DefaultValue ?? false) };
                    toggle.SetEnabled(!_readOnly);
                    toggle.RegisterValueChangedCallback(evt => Mutate(action, () => owner[definition.Name] = evt.newValue));
                    row.Add(toggle);
                    break;
                case "int":
                    var integer = new IntegerField(definition.Name) { value = token?.Value<int>() ?? Convert.ToInt32(definition.DefaultValue ?? 0) };
                    integer.SetEnabled(!_readOnly);
                    integer.RegisterValueChangedCallback(evt => Mutate(action, () => owner[definition.Name] = evt.newValue));
                    row.Add(integer);
                    AddClear(row, owner, definition, action);
                    break;
                case "number":
                    var number = new FloatField(definition.Name) { value = token?.Value<float>() ?? Convert.ToSingle(definition.DefaultValue ?? 0f) };
                    number.SetEnabled(!_readOnly);
                    number.RegisterValueChangedCallback(evt => Mutate(action, () => owner[definition.Name] = evt.newValue));
                    row.Add(number);
                    AddClear(row, owner, definition, action);
                    break;
                case "string":
                    var text = new TextField(definition.Name) { value = token?.Value<string>() ?? string.Empty };
                    text.SetEnabled(!_readOnly);
                    text.RegisterCallback<FocusOutEvent>(_ =>
                    {
                        if ((owner.Value<string>(definition.Name) ?? string.Empty) != text.value) Mutate(action, () => owner[definition.Name] = text.value);
                    });
                    row.Add(text);
                    break;
                default:
                    var json = new TextField(definition.Name) { multiline = true, value = token?.ToString(Formatting.Indented) ?? "[]" };
                    json.style.minHeight = 48;
                    json.SetEnabled(!_readOnly);
                    json.RegisterCallback<FocusOutEvent>(_ =>
                    {
                        try
                        {
                            var parsed = JToken.Parse(json.value);
                            if (!(parsed is JArray)) throw new JsonException("Expected a JSON array.");
                            if (!JToken.DeepEquals(owner[definition.Name], parsed)) Mutate(action, () => owner[definition.Name] = parsed);
                        }
                        catch (Exception exception) { EditorUtility.DisplayDialog("Invalid field JSON", exception.Message, "OK"); }
                    });
                    row.Add(json);
                    break;
            }
            return row;
        }

        private void AddClear(VisualElement row, JObject owner, GraphFieldDefinition definition, string action)
        {
            if (definition.Required || owner[definition.Name] == null) return;
            var clear = new Button(() => Mutate(action, () => owner.Remove(definition.Name))) { text = "Clear optional value" };
            clear.SetEnabled(!_readOnly);
            row.Add(clear);
        }

        private VisualElement EdgeInspector()
        {
            var foldout = new Foldout { text = "Edges", value = true };
            foreach (var pair in _document.EdgeRows().Where(pair => pair.Edge.Value<string>("from") == _selectedName || pair.Edge.Value<string>("to") == _selectedName).ToList())
            {
                var row = new VisualElement();
                row.style.marginBottom = 5;
                row.Add(new Label($"{pair.Kind}: {pair.Edge.Value<string>("from")} → {pair.Edge.Value<string>("to")}"));
                var payload = new TextField { multiline = true, value = pair.Edge.ToString(Formatting.Indented) };
                payload.SetEnabled(!_readOnly);
                payload.RegisterCallback<FocusOutEvent>(_ =>
                {
                    try
                    {
                        var replacement = JObject.Parse(payload.value);
                        if (!JToken.DeepEquals(pair.Edge, replacement)) Mutate("Edit edge", () => pair.Edge.Replace(replacement));
                    }
                    catch (Exception exception) { EditorUtility.DisplayDialog("Invalid edge JSON", exception.Message, "OK"); }
                });
                row.Add(payload);
                var controls = new VisualElement();
                controls.style.flexDirection = FlexDirection.Row;
                if (pair.Kind == "process")
                {
                    controls.Add(new Button(() => MoveProcess(pair.Edge, -1)) { text = "↑" });
                    controls.Add(new Button(() => MoveProcess(pair.Edge, 1)) { text = "↓" });
                }
                controls.Add(new Button(() => Mutate("Delete edge", pair.Edge.Remove)) { text = "Remove" });
                row.Add(controls);
                foldout.Add(row);
            }
            foldout.Add(AddEdgeControls());
            return foldout;
        }

        private VisualElement AddEdgeControls()
        {
            var root = new Foldout { text = "Add outgoing edge", value = false };
            var legalKinds = GraphSchema.Edges.Values.Where(edge => edge.From.Contains(_selectedKind)).Select(edge => edge.Kind).ToList();
            if (legalKinds.Count == 0)
            {
                root.Add(new Label("This node kind has no outgoing edge types."));
                return root;
            }
            var kind = new DropdownField("Kind", legalKinds, 0);
            var target = new DropdownField("Target");
            void RefreshTargets()
            {
                var edge = GraphSchema.Edges[kind.value];
                target.choices = _document.Nodes().Where(pair => edge.To.Contains(pair.Kind)).Select(pair => pair.Node.Value<string>("name")).ToList();
                target.value = target.choices.FirstOrDefault();
            }
            kind.RegisterValueChangedCallback(_ => RefreshTargets());
            RefreshTargets();
            var add = new Button(() =>
            {
                if (string.IsNullOrEmpty(target.value)) return;
                Mutate("Add edge", () => GraphMutation.AddEdge(_document, kind.value, _selectedName, target.value));
            }) { text = "Add Edge" };
            add.SetEnabled(!_readOnly);
            root.Add(kind);
            root.Add(target);
            root.Add(add);
            return root;
        }

        private VisualElement IdTableInspector()
        {
            var root = new Foldout { text = "ID Tables", value = false };
            foreach (var space in GraphSchema.IdSpaces)
            {
                var table = new Foldout { text = space, value = false };
                var rows = GraphJsonDocument.Array(_document.IdTable, space);
                for (var index = 0; index < rows.Count; index++)
                {
                    var at = index;
                    var line = new VisualElement();
                    line.style.flexDirection = FlexDirection.Row;
                    line.Add(new Label($"{index}: {rows[index].Value<string>()}") { style = { flexGrow = 1 } });
                    line.Add(new Button(() => ConfirmMoveId(space, at, at - 1)) { text = "↑" });
                    line.Add(new Button(() => ConfirmMoveId(space, at, at + 1)) { text = "↓" });
                    line.Add(new Button(() => ConfirmDeleteId(space, at)) { text = "×" });
                    table.Add(line);
                }
                var available = _document.Nodes().Where(pair => pair.Kind == space).Select(pair => pair.Node.Value<string>("name"))
                    .Where(name => !rows.Any(token => token.Value<string>() == name)).ToList();
                if (available.Count > 0)
                {
                    var pick = new DropdownField("Untabled", available, 0);
                    table.Add(pick);
                    table.Add(new Button(() => Mutate("Mint id", () => rows.Add(pick.value))) { text = "Append ID" });
                }
                root.Add(table);
            }
            root.SetEnabled(!_readOnly);
            return root;
        }

        private VisualElement NotesInspector()
        {
            var root = new Foldout { text = "Notes", value = false };
            foreach (var note in _document.Notes.OfType<JObject>().ToList())
            {
                var text = new TextField { multiline = true, value = note.Value<string>("text") ?? string.Empty };
                text.RegisterCallback<FocusOutEvent>(_ =>
                {
                    if (note.Value<string>("text") != text.value) Mutate("Edit note", () => note["text"] = text.value);
                });
                root.Add(text);
                var position = new VisualElement();
                position.style.flexDirection = FlexDirection.Row;
                var x = new FloatField("x") { value = note.Value<float?>("x") ?? 0 };
                var y = new FloatField("y") { value = note.Value<float?>("y") ?? 0 };
                x.RegisterValueChangedCallback(evt => Mutate("Move note", () => note["x"] = evt.newValue));
                y.RegisterValueChangedCallback(evt => Mutate("Move note", () => note["y"] = evt.newValue));
                position.Add(x);
                position.Add(y);
                root.Add(position);
                root.Add(new Button(() => Mutate("Delete note", note.Remove)) { text = "Delete Note" });
            }
            root.Add(new Button(() => Mutate("Add note", () => _document.Notes.Add(new JObject
            {
                ["id"] = "note-" + DateTime.UtcNow.Ticks.ToString("x"), ["x"] = 60, ["y"] = 60, ["text"] = "New note"
            }))) { text = "Add Note" });
            root.SetEnabled(!_readOnly);
            return root;
        }

        private VisualElement IssuesInspector()
        {
            var root = new Foldout { text = $"Issues ({_issues.Count})", value = _issues.Any(issue => issue.Severity == GraphIssueSeverity.Error) };
            if (_issues.Count == 0) root.Add(new Label("Graph is valid."));
            foreach (var issue in _issues)
            {
                var box = HelpBox(issue.ToString(), issue.Severity == GraphIssueSeverity.Error ? HelpBoxMessageType.Error : HelpBoxMessageType.Warning);
                if (!string.IsNullOrEmpty(issue.NodeName))
                {
                    box.RegisterCallback<PointerDownEvent>(_ =>
                    {
                        var kind = _document.FindKind(issue.NodeName);
                        if (kind != null) SelectNode(kind, issue.NodeName);
                    });
                }
                root.Add(box);
            }
            return root;
        }

        private void ImportJson()
        {
            if (hasUnsavedChanges && !EditorUtility.DisplayDialog("Discard unsaved changes?", "Importing another graph replaces the current unsaved document.", "Import", "Cancel")) return;
            var path = EditorUtility.OpenFilePanel("Import Cooking Graph JSON", string.IsNullOrEmpty(_sourcePath) ? Application.dataPath : Path.GetDirectoryName(_sourcePath), "json");
            if (string.IsNullOrEmpty(path)) return;
            GraphImportResult result;
            try { result = GraphJsonDocument.Parse(File.ReadAllText(path)); }
            catch (Exception exception) { EditorUtility.DisplayDialog("Import failed", exception.Message, "OK"); return; }
            if (result.Document == null || result.Document.VertexCount == 0)
            {
                EditorUtility.DisplayDialog("Import rejected", string.Join("\n", result.Issues.DefaultIfEmpty("The document contains zero graph nodes.")), "OK");
                return;
            }
            if (result.Issues.Count > 0 && !EditorUtility.DisplayDialog("Import repairs", string.Join("\n", result.Issues) + "\n\nOpen the repaired document?", "Open", "Cancel")) return;
            _document = result.Document;
            _sourcePath = path;
            _selectedKind = null;
            _selectedName = null;
            _readOnly = _document.SchemaVersion != GraphSchema.SupportedVersion;
            _undoState.json = _document.ToJson();
            _savedJson = _undoState.json;
            Undo.ClearUndo(_undoState);
            hasUnsavedChanges = false;
            saveChangesMessage = "Save changes to the graph JSON?";
            CreateGUI();
        }

        private bool SaveJson()
        {
            if (_document == null) return false;
            if (_readOnly)
            {
                EditorUtility.DisplayDialog("Read-only schema", $"Schema version {_document.SchemaVersion} is newer than this package supports. Use Export to make a copy without binding it as the saved source.", "OK");
                return false;
            }
            if (string.IsNullOrEmpty(_sourcePath))
            {
                _sourcePath = EditorUtility.SaveFilePanel("Save Cooking Graph JSON", Application.dataPath, _document.MapId + ".json", "json");
                if (string.IsNullOrEmpty(_sourcePath)) return false;
            }
            try
            {
                File.WriteAllText(_sourcePath, _document.ToJson());
                _savedJson = _document.ToJson();
                hasUnsavedChanges = false;
                AssetDatabase.Refresh();
                UpdateStatus("Saved " + _sourcePath);
                return true;
            }
            catch (Exception exception)
            {
                EditorUtility.DisplayDialog("Save failed", exception.Message, "OK");
                return false;
            }
        }

        private void ExportJson()
        {
            if (_document == null) return;
            var path = EditorUtility.SaveFilePanel("Export Cooking Graph JSON", Application.dataPath, _document.MapId + ".json", "json");
            if (string.IsNullOrEmpty(path)) return;
            try { File.WriteAllText(path, _document.ToJson()); }
            catch (Exception exception) { EditorUtility.DisplayDialog("Export failed", exception.Message, "OK"); }
        }

        private void GenerateOrSync()
        {
            if (_document == null || _readOnly) return;
            var errors = GraphValidator.Validate(_document).Where(issue => issue.Severity == GraphIssueSeverity.Error).ToList();
            if (errors.Count > 0)
            {
                EditorUtility.DisplayDialog("Generation blocked", string.Join("\n", errors.Take(20)), "OK");
                return;
            }
            GraphSyncDifference diff;
            try
            {
                diff = GraphAssetSynchronizer.Compare(_document, _generationConfig);
            }
            catch (Exception exception)
            {
                EditorUtility.DisplayDialog("Invalid generation config", exception.Message, "OK");
                return;
            }
            var verb = GraphAssetSynchronizer.HasGeneratedAssets(_document.MapId, _generationConfig) ? "Sync" : "Generate";
            if (!EditorUtility.DisplayDialog(verb + " Cooking Graph", diff.Summary(), verb, "Cancel")) return;
            try
            {
                var asset = GraphAssetSynchronizer.Synchronize(_document, _sourcePath, diff, _generationConfig);
                Selection.activeObject = asset;
                EditorGUIUtility.PingObject(asset);
                Refresh();
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
                EditorUtility.DisplayDialog("Asset generation failed", exception.Message, "OK");
            }
        }

        private CookingNodeAsset ResolveGeneratedAsset(string kind, string name)
        {
            if (_document == null) return null;
            try { return GraphAssetSynchronizer.ResolveSpriteAsset(_document.MapId, kind, name, _generationConfig); }
            catch (InvalidOperationException) { return null; }
        }

        private void ShowAddNodeMenu()
        {
            if (_document == null || _readOnly) return;
            var menu = new GenericMenu();
            foreach (var kind in GraphSchema.VertexKinds)
            {
                var captured = kind;
                menu.AddItem(new GUIContent(GraphSchema.Vertices[kind].Label), false, () =>
                {
                    JObject node = null;
                    Mutate("Add " + captured, () => node = GraphMutation.AddNode(_document, captured));
                    _selectedKind = captured;
                    _selectedName = node?.Value<string>("name");
                    Refresh();
                });
            }
            menu.ShowAsContext();
        }

        private void DeleteSelectedNode()
        {
            if (_selectedName == null || _readOnly) return;
            var id = GraphJsonDocument.Array(_document.IdTable, _selectedKind).Select((token, index) => (token, index))
                .FirstOrDefault(pair => pair.token.Value<string>() == _selectedName).index;
            var message = $"Delete {_selectedKind} '{_selectedName}' and all incident edges?";
            if (id >= 0 && GraphJsonDocument.Array(_document.IdTable, _selectedKind).ElementAtOrDefault(id)?.Value<string>() == _selectedName)
                message += $"\n\nThis removes positional ID {id} and renumbers every later {_selectedKind} ID.";
            if (!EditorUtility.DisplayDialog("Delete node", message, "Delete", "Cancel")) return;
            var kind = _selectedKind;
            var name = _selectedName;
            Mutate("Delete node", () => GraphMutation.DeleteNode(_document, kind, name));
            _selectedKind = null;
            _selectedName = null;
            Refresh();
        }

        private void SelectNode(string kind, string name)
        {
            _selectedKind = kind;
            _selectedName = name;
            Refresh();
        }

        private void AutoLayout()
        {
            if (_document == null || _readOnly) return;
            Mutate("Auto layout", () =>
            {
                var lanes = new Dictionary<string, int>();
                foreach (var pair in _document.Nodes())
                {
                    var lane = pair.Kind == "tool" ? 0 : pair.Kind == "ingredient" && pair.Node.Value<bool?>("pickupable") == true ? 1
                        : pair.Kind == "ingredient" ? 2 : pair.Kind == "group" ? 3 : pair.Kind == "composite" ? 4 : 5;
                    var row = lanes.TryGetValue(pair.Kind + lane, out var value) ? value : 0;
                    lanes[pair.Kind + lane] = row + 1;
                    _document.Layout[$"{pair.Kind}:{pair.Node.Value<string>("name")}"] = new JObject { ["x"] = 50 + lane * 240, ["y"] = 50 + row * 105 };
                }
            });
        }

        private void ConfirmMoveId(string space, int from, int to)
        {
            var rows = GraphJsonDocument.Array(_document.IdTable, space);
            if (to < 0 || to >= rows.Count) return;
            if (!EditorUtility.DisplayDialog("Renumber IDs", $"Move {space} ID {from} to {to}? Every ID in the shifted range changes meaning in level strings.", "Move", "Cancel")) return;
            Mutate("Reorder id table", () => GraphMutation.MoveId(_document, space, from, to));
        }

        private void ConfirmDeleteId(string space, int index)
        {
            if (!EditorUtility.DisplayDialog("Remove ID", $"Remove {space} ID {index}? Every later ID shifts down and changes meaning in level strings.", "Remove", "Cancel")) return;
            Mutate("Remove id", () => GraphJsonDocument.Array(_document.IdTable, space).RemoveAt(index));
        }

        private void MoveProcess(JObject edge, int direction)
        {
            var rows = GraphJsonDocument.Array(_document.Edges, "process");
            var tool = edge.Value<string>("from");
            var toolRows = rows.OfType<JObject>().Where(value => value.Value<string>("from") == tool).ToList();
            var at = toolRows.IndexOf(edge);
            var target = at + direction;
            if (at < 0 || target < 0 || target >= toolRows.Count) return;
            Mutate("Reorder process", () =>
            {
                var globalFrom = rows.IndexOf(edge);
                var globalTo = rows.IndexOf(toolRows[target]);
                edge.Remove();
                rows.Insert(globalTo > globalFrom ? globalTo : globalTo, edge);
            });
        }

        private void Mutate(string action, Action mutation)
        {
            if (_document == null || _readOnly) return;
            Undo.RecordObject(_undoState, action);
            try { mutation(); }
            catch (Exception exception)
            {
                EditorUtility.DisplayDialog("Edit rejected", exception.Message, "OK");
                return;
            }
            _undoState.json = _document.ToJson();
            EditorUtility.SetDirty(_undoState);
            hasUnsavedChanges = !string.Equals(_savedJson, _undoState.json, StringComparison.Ordinal);
            Refresh();
        }

        private void CommitCurrent(string action)
        {
            Undo.RecordObject(_undoState, action);
            _undoState.json = _document.ToJson();
            EditorUtility.SetDirty(_undoState);
            hasUnsavedChanges = !string.Equals(_savedJson, _undoState.json, StringComparison.Ordinal);
        }

        private void OnUndoRedo()
        {
            if (_undoState == null || string.IsNullOrEmpty(_undoState.json)) return;
            var parsed = GraphJsonDocument.Parse(_undoState.json);
            if (parsed.Document == null) return;
            _document = parsed.Document;
            hasUnsavedChanges = !string.Equals(_savedJson, _undoState.json, StringComparison.Ordinal);
            Refresh();
        }

        private void OnKeyDown(KeyDownEvent evt)
        {
            if (!evt.ctrlKey && !evt.commandKey) return;
            if (evt.keyCode == KeyCode.S)
            {
                SaveJson();
                evt.StopPropagation();
            }
            else if (evt.keyCode == KeyCode.Z && evt.shiftKey || evt.keyCode == KeyCode.Y)
            {
                Undo.PerformRedo();
                evt.StopPropagation();
            }
            else if (evt.keyCode == KeyCode.Z)
            {
                Undo.PerformUndo();
                evt.StopPropagation();
            }
        }

        private static HelpBox HelpBox(string message, HelpBoxMessageType type)
        {
            return new HelpBox(message, type);
        }
    }
}
