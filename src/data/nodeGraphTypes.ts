// TypeScript mirror of config/nodegraph/schema.json, plus the shapes a map
// document (burger.json, ...) takes once parsed.
//
// Deliberately a PURE LEAF: types only, zero imports. configLoader.ts will
// import this, and configLoader -> levelSnapshot -> sheetSource -> configLoader
// is the cycle class this codebase has already been bitten by twice (see
// csvColumns.ts's header comment). Nothing here may import config or any
// module that reads it.
//
// The schema file — not this module — is what drives the editor: the inspector
// fields, the creatable-vertex palette, the legal wiring matrix and the
// invariant list all come from `fields[]`/`edgeKinds[]`/`invariants[]` at
// runtime. These interfaces exist so map DATA is typed at the call site; a
// drift test asserts every schema field name appears in the matching interface
// here, so the two can't silently diverge.

// ---------- schema.json ----------

export type FieldType = "string" | "int" | "number" | "bool" | "enum" | "ref" | "ref[]" | "int[]";

export interface FieldDef {
  name: string;
  type: FieldType;
  required?: boolean;
  unique?: boolean;
  /** Applied when the data omits the field. */
  default?: string | number | boolean;
  min?: number;
  max?: number;
  minItems?: number;
  /** `enum` only. */
  options?: string[];
  /** `ref`/`ref[]` only — which vertex kinds the reference may name. */
  refKinds?: VertexKindName[];
  description?: string;
}

export type VertexKindName = "ingredient" | "tool" | "group" | "composite" | "dirty";
export type EdgeKindName = "process" | "base" | "topping" | "option" | "leavesDirty";

export interface VertexKindDef {
  kind: VertexKindName;
  label: string;
  color: string;
  description?: string;
  fields: FieldDef[];
}

export interface EdgeKindDef {
  kind: EdgeKindName;
  label: string;
  style: "solid" | "dashed" | "dotted";
  from: VertexKindName[];
  to: VertexKindName[];
  description?: string;
  /** At most this many edges of this kind may point AT one vertex. process = 1. */
  maxIncomingPerTarget?: number;
  /** At most this many may leave one vertex. base/topping/leavesDirty = 1. */
  maxOutgoingPerSource?: number;
  fields: FieldDef[];
}

export interface InvariantDef {
  id: string;
  severity: "error" | "warning";
  description: string;
}

export interface NodeGraphSchema {
  schemaVersion: number;
  fieldTypes: { type: FieldType; widget: string; step?: number; note?: string }[];
  mapFields: FieldDef[];
  vertexKinds: VertexKindDef[];
  edgeKinds: EdgeKindDef[];
  invariants: InvariantDef[];
}

// ---------- the id table ----------
// Level strings never name a vertex. Every integer in a queue, grid or
// customer string is a DATA ID resolved through this table to a node name.
// That indirection is what lets a designer add, remove and rename nodes
// without silently repointing committed levels — see nodeIdTable.ts for the
// append-only / tombstone / free-rename rules that make it safe.

export type IdSpace = "ingredient" | "composite" | "group" | "tool" | "dirty";

export interface IdEntry {
  id: number;
  /** null = tombstone: the id is permanently retired, never reissued. */
  node: string | null;
  /** The name this id used to point at, kept for diagnostics. Set with `node: null`. */
  retired?: string;
}

export type IdTable = Record<IdSpace, IdEntry[]>;

// ---------- vertices ----------

export interface IngredientVertex {
  name: string;
  displayName: string;
  /** Comes off the queue — a graph leaf, where a traceback terminates. */
  pickupable?: boolean;
  /** May occupy a dish slot. Raw items (bun, potato) are not; their outputs are. */
  servable?: boolean;
  /** Dish slots ONE landed piece can fill before it's consumed. >1 also disables direct-serve. */
  usageNum?: number;
  /** Max copies one dish may call for; 0 = unlimited. */
  limitPerDish?: number;
  numSlices?: number;
  price?: number;
  code?: string;
  emoji?: string;
  localImage?: string;
  fileId?: string;
  /** Legacy ids, present only where a runtime counterpart exists. Read by the migration. */
  runtimeRawId?: number;
  runtimeCookedId?: number;
}

export interface ToolVertex {
  name: string;
  displayName: string;
  /** Items cooking here simultaneously. */
  numSlots: number;
  /** Default seconds per item; a process edge may override it. */
  cookingTime: number;
  upgradeCosts?: number[];
  emoji?: string;
  localImage?: string;
  fileId?: string;
  runtimeToolId?: number;
}

export interface GroupVertex {
  name: string;
  displayName: string;
  /**
   * Total picks across all options; -1 = unlimited (makes variant count
   * unbounded), 1 = exactly one option.
   *
   * There is deliberately no SINGLE/MULTIPLE kind. "Choose exactly one" is
   * just `maxQuantity: 1`, which collapses two concepts into one number and
   * removes every "which rule wins" question between them.
   */
  maxQuantity?: number;
}

export interface CompositeVertex {
  name: string;
  displayName: string;
  /** A customer may order this — a graph root, where the tracer starts. */
  orderable?: boolean;
  /**
   * The topping slot must be filled. False = a bare base is a legal order
   * (plain fries). Enforced when a designer authors a dish, and honoured by
   * the customer auto-generator rather than left to chance.
   */
  toppingRequired?: boolean;
}

export interface DirtyVertex {
  name: string;
  displayName: string;
  emoji?: string;
  localImage?: string;
  fileId?: string;
  runtimeDirtyId?: number;
}

export interface VertexSets {
  ingredient: IngredientVertex[];
  tool: ToolVertex[];
  group: GroupVertex[];
  composite: CompositeVertex[];
  dirty: DirtyVertex[];
}

// ---------- edges ----------

/** One recipe row. At most one may target any ingredient — that cap is what makes a backward trace deterministic. */
export interface ProcessEdge {
  from: string; // tool
  to: string; // ingredient produced
  /** A list so multi-input recipes stay expressible; every current recipe uses exactly one. */
  inputs: string[];
  /** Pieces produced per pickup. */
  amount: number;
  /** Overrides the tool's cookingTime for this recipe only. */
  duration?: number;
  /**
   * Extra tools visited in order after `from`, before `to` appears. Produces NO
   * intermediate vertex and never touches the grid (potato: cutting board, then
   * fryer, then 2 fries). Contrast the chicken route, which uses two process
   * edges and a real `*-flour-coated` vertex because the coating IS an item state.
   */
  chainTools?: string[];
}

export interface SimpleEdge {
  from: string;
  to: string;
}

export interface OptionEdge extends SimpleEdge {
  /** Max copies of THIS option, independent of the group total; -1 = unlimited. */
  maxQuantity?: number;
}

export interface EdgeSets {
  process: ProcessEdge[];
  base: SimpleEdge[];
  topping: SimpleEdge[];
  option: OptionEdge[];
  leavesDirty: SimpleEdge[];
}

// ---------- the document ----------

export interface NodeGraphMapHeader {
  id: string;
  name: string;
  gridWidth: number;
  gridHeight: number;
  dirtyStackHeight: number;
  visibleRows: number;
}

export interface NodeGraphMap {
  schemaVersion: number;
  map: NodeGraphMapHeader;
  idTable: IdTable;
  vertices: VertexSets;
  edges: EdgeSets;
  /** Editor node positions, keyed "kind:name". Kept apart so semantic data stays diff-clean. */
  layout?: Record<string, { x: number; y: number }>;
}

/** Any vertex, when the kind is known only at runtime. */
export type AnyVertex =
  | IngredientVertex
  | ToolVertex
  | GroupVertex
  | CompositeVertex
  | DirtyVertex;

/** Every vertex kind has a `name`; this is the shape shared code relies on. */
export interface NamedVertex {
  name: string;
}
