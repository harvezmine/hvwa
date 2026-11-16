// model.ts — RM-12's virtual sales ledger, its relation graph, the cursor, the preview builder, the contract every
// levels/<level>.ts implements and the proof. Not served: View Source shows only levels/*.ts, and nothing here has a
// route. The lab keeps no state: the ledger is derived from the row number, nothing is stored.
//
// Platform safety (rule: bounded everything): the work this lab does for a request is the size of its 20-row PREVIEW,
// never of the plan. "Unbounded" is the lab's SIMULATED sense: the cost is computed arithmetically (rows x the product
// of the fan-outs), in Numbers, and nothing loops to `rows` or allocates per planned row.

/** The ledger's size: rows 1 .. TOTAL_ROWS exist, each derived from its number (test seam). */
export const TOTAL_ROWS = 2_500_000;

/** The relations of the graph a request may expand (`expand=product.related`). */
export type Relation = 'product' | 'related' | 'reviews';

/**
 * How many records one step of each relation stands for: a row has 1 product, a product 20 related products and 50
 * reviews (a leaf). Frozen: a test that needs another table (to reach the Divine cost budget, which no request can reach
 * otherwise) installs it with setFanoutForTests and restores it.
 */
export const FANOUT: Readonly<Record<Relation, number>> = Object.freeze({ product: 1, related: 20, reviews: 50 });

let fanout: Readonly<Record<Relation, number>> = FANOUT;

/** Test seam: use these fan-outs (the others unchanged) until the returned function is called, like setClockForTests. */
export function setFanoutForTests(o: Partial<Record<Relation, number>>): () => void {
  const prev = fanout;
  fanout = Object.freeze({ ...prev, ...o });
  return () => { fanout = prev; };
}

/** A served plan whose cost reaches this earns the flag (below Divine). */
export const FLAG_COST = 100_000;

/** A cost from this on is shown as `>= 10^15`. */
export const COST_SHOWN_UP_TO = 1e15;

/** What the lab materializes of a plan, whatever the plan says (platform safety). */
export const PREVIEW = Object.freeze({ rows: 20, children: 3, depth: 3 });

/** Parser bounds, not the lesson: segments of `expand` and its length. */
export const EXPAND_LIMITS = Object.freeze({ segments: 10, length: 200 });

/** The proof (the oracle, not the flaw): a served plan whose cost is at least FLAG_COST. */
export function proves(cost: number): boolean {
  return cost >= FLAG_COST;
}

// --- The contract ---------------------------------------------------------------------------------------------------

/** What a level gets of a request: the raw `limit` and `expand` (absent = undefined) and the cursor's offset. */
export interface PlanInput {
  readonly limit: string | undefined;
  readonly offset: number;
  readonly expand: string | undefined;
}

/** What a level decided: how many rows the export covers, and the `expand` segments (the graph validates them). */
export interface Plan { readonly rows: number; readonly expand: readonly string[] }

/** A level's refusal. */
export interface Refusal { readonly status: number; readonly error: string }

/** What every levels/<level>.ts exports (checked by byLevel<ExportLevel> in challenge.ts). */
export interface ExportLevel {
  plan(input: PlanInput): Plan | Refusal;
  /** A refusal text when `cost` is over the level's budget (413), else undefined. */
  overBudget(cost: number): string | undefined;
}

// --- The cursor: base64url of the offset, at every level (not the lesson) ---------------------------------------------

export const cursorOf = (offset: number): string => Buffer.from(String(offset)).toString('base64url');

/** The offset a cursor stands for, or undefined when it is no cursor this lab issued (canonical form, 0 .. TOTAL_ROWS). */
export function offsetOf(cursor: string): number | undefined {
  if (!/^[A-Za-z0-9_-]{1,12}$/.test(cursor)) return undefined;
  const text = Buffer.from(cursor, 'base64url').toString('latin1');
  if (!/^\d{1,7}$/.test(text)) return undefined;
  const n = Number(text);
  return n <= TOTAL_ROWS && cursorOf(n) === cursor ? n : undefined;
}

// --- The relation graph ---------------------------------------------------------------------------------------------

type Node = 'row' | 'product' | 'leaf';
const GRAPH: ReadonlyMap<Node, ReadonlyMap<string, { readonly to: Node; readonly relation: Relation }>> = new Map([
  ['row', new Map([['product', { to: 'product' as const, relation: 'product' as const }]])],
  ['product', new Map([
    ['related', { to: 'product' as const, relation: 'related' as const }],
    ['reviews', { to: 'leaf' as const, relation: 'reviews' as const }],
  ])],
  ['leaf', new Map()],
]);

/**
 * Walk `segments` along the graph from a row: the product of the fan-outs (1 for no expansion), or why the path is
 * wrong (an unknown relation, a relation after a leaf, too many segments). Relations are looked up in Maps, never by
 * an object index, so `constructor` is no relation.
 */
export function walkExpand(segments: readonly string[]): { readonly multiplier: number } | { readonly error: string } {
  if (segments.length > EXPAND_LIMITS.segments) return { error: `expand: at most ${EXPAND_LIMITS.segments} segments.` };
  let at: Node = 'row';
  let multiplier = 1;
  for (const seg of segments) {
    const step: { readonly to: Node; readonly relation: Relation } | undefined = GRAPH.get(at)?.get(seg);
    if (step === undefined) return { error: `expand: unknown relation "${seg.length > 30 ? `${seg.slice(0, 30)}...` : seg}" here.` };
    multiplier *= fanout[step.relation];
    at = step.to;
  }
  return { multiplier };
}

// --- The preview: derived rows, a few of them, a few children each --------------------------------------------------

const NAMES = ['Votive Candle', 'Silver Chalice', 'Pilgrim\'s Rosary', 'Reliquary', 'Incense Burner', 'Pewter Lantern', 'Wax Seal', 'Prayer Cord'];
const PRODUCTS = 5000;

const productId = (rowId: number): number => (rowId * 7919) % PRODUCTS;
const relatedId = (pid: number, j: number): number => (pid * 31 + j * 17 + 1) % PRODUCTS;
const productNode = (pid: number): { sku: string; name: string; price: number } => ({
  sku: `P-${String(pid).padStart(4, '0')}`, name: NAMES[pid % NAMES.length], price: 250 + (pid % 40) * 100,
});

/** A product node expanded along `segs` (at most PREVIEW.children children per relation). */
function productWith(pid: number, segs: readonly string[]): Record<string, unknown> {
  const node: Record<string, unknown> = productNode(pid);
  const [relation, ...rest] = segs;
  if (relation === 'related') {
    node.related = Array.from({ length: PREVIEW.children }, (_, j) => productWith(relatedId(pid, j), rest));
  } else if (relation === 'reviews') {
    node.reviews = Array.from({ length: PREVIEW.children }, (_, j) => ({ id: pid * 100 + j, stars: 1 + ((pid + j) % 5), text: `Review ${j + 1} of ${node.sku}` }));
  }
  return node;
}

/**
 * The first `count` rows of the export from `offset` (row ids offset+1 ..), at most PREVIEW.rows, each expanded along the
 * first PREVIEW.depth segments. The only loop is over the preview: its size does not depend on the plan.
 */
export function previewRows(offset: number, count: number, segments: readonly string[]): Record<string, unknown>[] {
  const segs = segments.slice(0, PREVIEW.depth);
  return Array.from({ length: Math.min(Math.max(count, 0), PREVIEW.rows) }, (_, k) => {
    const id = offset + k + 1;
    const row: Record<string, unknown> = { id, orderNo: 100_000 + id, sku: productNode(productId(id)).sku, qty: 1 + (id * 7) % 5 };
    if (segs[0] === 'product') row.product = productWith(productId(id), segs.slice(1));
    return row;
  });
}
