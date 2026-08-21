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

export type FieldType =
  | "string"
  | "int"
  | "number"
  | "bool"
  | "enum"
  | "ref"
  | "ref[]"
  | "int[]"
  | "string[]"
  // Lists of records, each with its own bespoke inspector widget: a tool's slot
  // points, and a recipe's inputs with the point each enters.
  | "slotConfig[]"
  | "processInput[]";

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
export type EdgeKindName = "process" | "preservation" | "base" | "topping" | "option" | "leavesDirty";

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
// That indirection is what lets a designer rename nodes without silently
// repointing committed levels — see nodeIdTable.ts for the rules.
//
// The id IS THE ROW'S POSITION. `idTable.ingredient[13]` is what a queue digit
// `13` picks up; `idTable.composite[0]` is what a dish's `{c0:` names. There is
// no stored `id` field on purpose: a position and a number meant to agree are
// two places to disagree, and the loser is always the one level strings used.

export type IdSpace = "ingredient" | "composite" | "group" | "tool" | "dirty";

/**
 * One ordered list of node names per space. The INDEX is the id.
 *
 * A plain string array, with no tombstones: deleting a node removes its row and
 * renumbers everything after it, exactly as reordering does. That is a real
 * consequence the designer confirms, not something the format hides — and it
 * keeps the table to one fact per row, so there is no "is this slot dead?"
 * state for a reader to get wrong.
 */
export type IdTable = Record<IdSpace, string[]>;

// ---------- vertices ----------

export interface IngredientVertex {
  name: string;
  displayName: string;
  /** Comes off the queue — a graph leaf, where a traceback terminates. */
  pickupable?: boolean;
  /** Dish slots ONE landed piece can fill before it's consumed. >1 also disables direct-serve. */
  usageNum?: number;
  price?: number;
  code?: string;
  emoji?: string;
  localImage?: string;
  imageURL?: string;
  fileId?: string;
}

/**
 * One slot POINT of a tool: a named place an ingredient goes, with `slot`
 * parallel positions.
 *
 * This is what replaced a flat `numSlots`. A single-input tool has one point
 * whose `slot` is the old count. A multi-input tool has one point per
 * ingredient — a coffee machine holds ground coffee in one point and a cup in
 * another — and the recipe only runs once every point it names is filled.
 *
 * The parallel positions are called LANES throughout the sim. A job occupies
 * the same lane across every point it needs, which is what makes "which cup
 * goes with which coffee" answerable rather than arbitrary.
 */
export interface ToolSlotConfig {
  /** Shown in the inspector's slot dropdowns. */
  name: string;
  /** Parallel positions at this point. Two lanes means two jobs at once. */
  slot: number;
}

export interface ToolVertex {
  name: string;
  displayName: string;
  /** The tool's slot points, in the order the inspector lists them. */
  slotConfigs: ToolSlotConfig[];
  /** Extra input buffers. Their accepted ingredients come from the tool's preservation edge. */
  preservationSlots?: number;
  /** Default seconds per item; a process edge may override it. */
  cookingTime: number;
  upgradeCosts?: number[];
  emoji?: string;
  localImage?: string;
  imageURL?: string;
  fileId?: string;
  runtimeToolId?: number;
}

export interface GroupVertex {
  name: string;
  displayName: string;
  /** Minimum total picks required across all options. Defaults to 0. */
  minQuantity?: number;
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
  /** Maximum objects in one stack; absent uses the map-wide dirtyStackHeight fallback. */
  maxStack?: number;
  emoji?: string;
  localImage?: string;
  imageURL?: string;
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

/** One ingredient a recipe consumes, and which of the tool's slot points it goes into. */
export interface ProcessInput {
  ingredient: string;
  /** Index into the source tool's `slotConfigs`. */
  slot: number;
}

/** One recipe row. At most one may target any ingredient — that cap is what makes a backward trace deterministic. */
export interface ProcessEdge {
  from: string; // tool
  to: string; // ingredient produced
  /**
   * Ingredients consumed, each with the tool slot POINT it enters. `slot`
   * indexes the source tool's `slotConfigs`; every point named here must be
   * filled before the recipe runs.
   */
  inputs: ProcessInput[];
  /** Pieces produced per pickup. */
  amount: number;
  /**
   * When true (the default), available inputs enter this process immediately.
   * When false, they wait until an active customer order needs this output (or
   * something produced downstream from it).
   */
  auto?: boolean;
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
  /** Tool-owned buffer accepting the wired ingredient, or every concrete option of a wired group. */
  preservation: SimpleEdge[];
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
  /**
   * Free-floating designer notes pinned to canvas positions.
   *
   * Editor furniture, like `layout` — the runtime, the validator and the CSV all
   * ignore them. They live in the document rather than in localStorage so a note
   * explaining WHY a route is spelled a particular way travels with the graph it
   * explains, through export, commit and review.
   */
  notes?: GraphNote[];
}

export interface GraphNote {
  id: string;
  x: number;
  y: number;
  text: string;
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
