// The map renderer: nodes in, one marker-wrapped block of two mermaid fences
// out. Nothing here talks to a tracker – the files backend hands it `loadNodes`
// and the github backend hands it `gh issue list --json ...` through the adapter
// in github-issues.ts, which this module deliberately does not import. The
// renderer stays a pure function of its input, so its tests are fixtures with no
// subprocess and no auth. See docs/adr/0013-the-diagram-renderer-is-pure.md.
//
// Four channels carry the four fields a reader wants at a glance: shape is
// kind, fill is status, a dark dashed border is an unresolved hitl node, and a
// magenta outline is the frontier. The label repeats the id, the kind and the
// status as text, so nothing depends on a renderer honouring the styling.
import {
  NODE_KINDS,
  NODE_STATUSES,
  bareId,
  compareIds,
  frontier,
  isSettled,
  rootCountError,
  type MapNode,
  type NodeKind,
  type NodeMode,
  type NodeStatus,
} from './nodes.js';

/**
 * A node as the renderer needs it: every field that reaches the drawing, plus
 * the address the id links to. `url` is where the two backends differ – an
 * issue has one and a file on disk does not.
 */
export interface DiagramNode {
  id: string;
  title: string;
  status: NodeStatus;
  mode: NodeMode;
  kind: NodeKind;
  label: string;
  answers?: string;
  blockedBy: string[];
  pinned: boolean;
  url?: string;
}

export interface RenderOptions {
  /** Draw this node and its descendants only; the whole map when absent. */
  from?: string;
}

// The markers are what let a regeneration replace the diagram in a node body
// without touching anything a human wrote around it.
export const DIAGRAM_START = '<!-- spechub:diagram -->';
export const DIAGRAM_END = '<!-- /spechub:diagram -->';

// ---------------------------------------------------------------------------
// The drawing
// ---------------------------------------------------------------------------

// The five kinds, as the mermaid shape that opens and closes a label. The
// label is always double-quoted, so the quotes belong to the shape.
const SHAPES: Record<NodeKind, readonly [string, string]> = {
  destination: ['{{"', '"}}'],
  notes: ['[["', '"]]'],
  decision: ['{"', '"}'],
  research: ['(["', '"])'],
  work: ['["', '"]'],
};

// The five statuses, as fills. GitHub's own light palette, so the dark label
// text reads on every one of them.
const FILLS: Record<NodeStatus, string> = {
  fog: '#f6f8fa',
  open: '#ddf4ff',
  claimed: '#fff8c5',
  resolved: '#dafbe1',
  'out-of-scope': '#ffebe9',
};

// A class name is a mermaid identifier, and `out-of-scope` is not one.
const STATUS_TOKENS: Record<NodeStatus, string> = {
  fog: 'fog',
  open: 'open',
  claimed: 'claimed',
  resolved: 'resolved',
  'out-of-scope': 'outOfScope',
};

const TEXT_COLOUR = '#1f2328';
const FRONTIER_STROKE = '#bf3989';
const HITL_STROKE = '#1f2328';
const NEUTRAL_STROKE = '#d0d7de';
const LEGEND_FILL = '#ffffff';

// Mermaid's default `-.->` dash reads as a solid line at a glance, so both the
// diagram and the legend restate it wide enough to separate the two edge kinds
// on sight.
const BLOCKED_DASH = 'stroke-dasharray:10 8';

/**
 * The two cues that can land on one node at once. They are a precedence, not a
 * conflict: the frontier owns the stroke colour and its width, so its outline
 * wins over the mode border, while the dash is a property nothing else claims
 * and survives on a node carrying both. A node with neither cue hides its
 * stroke behind its own fill, so no border shows at all.
 */
interface Cue {
  frontier: boolean;
  hitl: boolean;
}

const PLAIN: Cue = { frontier: false, hitl: false };
const HITL_ONLY: Cue = { frontier: false, hitl: true };
const FRONTIER_ONLY: Cue = { frontier: true, hitl: false };

// Source order, because mermaid resolves a stroke collision by it: every
// frontier classDef is defined after every one it has to beat.
function cueRank(cue: Cue): number {
  return (cue.frontier ? 2 : 0) + (cue.hitl ? 1 : 0);
}

function className(status: NodeStatus, cue: Cue): string {
  return STATUS_TOKENS[status] + (cue.frontier ? 'Front' : '') + (cue.hitl ? 'Hitl' : '');
}

/**
 * The stroke half of a cue, as the mermaid style properties that draw it.
 *
 * The fill is a parameter because the diagram and the legend disagree about it
 * and about nothing else: the diagram passes the node's own status fill, the
 * legend passes its flat swatch white. Everything that makes a cue recognisable
 * – the magenta at five pixels, the dark dash at two – is written here once, so
 * the legend cannot drift from the diagram it explains.
 */
function cueStroke(cue: Cue, fill: string): string[] {
  const parts: string[] = [];
  if (cue.frontier) parts.push(`stroke:${FRONTIER_STROKE}`, 'stroke-width:5px');
  else if (cue.hitl) parts.push(`stroke:${HITL_STROKE}`, 'stroke-width:2px');
  else parts.push(`stroke:${fill}`);
  if (cue.hitl) parts.push('stroke-dasharray:6 4');
  return parts;
}

function classDefLine(status: NodeStatus, cue: Cue): string {
  const fill = FILLS[status];
  const parts = [
    `classDef ${className(status, cue)} fill:${fill}`,
    `color:${TEXT_COLOUR}`,
    ...cueStroke(cue, fill),
  ];
  return `  ${parts.join(',')}`;
}

// A mermaid label is rendered as HTML, so every character that could be read as
// markup has to arrive as an entity: a raw `<db>` is swallowed as a tag and a
// raw `</a>` closes the anchor this file opens around the id.
//
// The ampersand goes first, or the entities the other three produce would be
// escaped a second time and reach the reader as `&amp;quot;`.
//
// The quote entity has to be the HTML one: mermaid rewrites its own `#quot;`
// form into a private sentinel built from codepoints above U+00FF, and
// `insertEdge` then runs `btoa(JSON.stringify(...))` over the node data, which
// is specified to throw on any codepoint above 255. One quoted label would take
// the whole fence down, but only once that node sits on an edge.
function escapeLabel(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The id, linked to its node's address when it has one.
 *
 * The anchor wraps the id alone, never the whole label, and its href takes
 * single quotes because the mermaid label is already double-quoted. A url is
 * therefore hostile input twice over: a single quote closes the href and
 * everything after it lands as further attributes on the anchor, and an angle
 * bracket closes the tag. Both are escaped.
 *
 * A url that is not a plain `https://` link is dropped rather than escaped. An
 * issue address is the only thing that belongs here, and a `javascript:` href
 * would run rather than navigate however well it were quoted.
 *
 * The quote becomes `&apos;` and never the numeric `&#39;`, for the reason
 * `escapeLabel` above uses `&quot;`: mermaid's `encodeEntities` rewrites
 * anything matching `#<word>;` into a sentinel built from codepoints above
 * U+00FF, and `&#39;` holds `#39;`. The named entity carries no hash, so it
 * passes through untouched and `btoa` never sees it.
 */
function linkedId(node: DiagramNode): string {
  const shown = `#${node.id}`;
  if (!node.url || !node.url.startsWith('https://')) return shown;
  const href = node.url.replace(/'/g, '&apos;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<a href='${href}'>${shown}</a>`;
}

// A mermaid identifier cannot open with a digit, so every node id is drawn
// behind an `n`. Both fences and every edge read the id through here.
function mermaidId(id: string): string {
  return `n${id}`;
}

// `frontier` and `deriveDepths` take a MapNode, and a DiagramNode is one
// without the two fields only a file on disk has.
function asMapNodes(nodes: DiagramNode[]): MapNode[] {
  return nodes.map(n => ({ ...n, body: '', file: '' }));
}

function resolveStart(nodes: DiagramNode[], from?: string): DiagramNode {
  if (from === undefined) {
    const roots = nodes.filter(n => !n.answers);
    if (roots.length !== 1) {
      throw new Error(rootCountError(roots.length));
    }
    return roots[0];
  }
  // An id is written padded on the files backend and bare on github, and a
  // reader copying one out of either has to be able to hand it straight back.
  // `compareIds` reads `2`, `002` and `0002` as one number, which is the whole
  // reason the match is a comparison rather than a string equality.
  const wanted = bareId(from);
  const found = nodes.find(n => compareIds(n.id, wanted) === 0);
  if (!found) throw new Error(`node ${wanted} is not in this map`);
  return found;
}

interface Drawn {
  node: DiagramNode;
  /** How many nodes a collapsed subtree hides below this one; 0 when nothing is hidden. */
  hidden: number;
}

/**
 * The nodes the diagram draws, in preorder from `start`.
 *
 * A resolved subtree collapses to its topmost node carrying a count, because a
 * readable diagram caps at roughly nine nodes and a real map passes that by the
 * second round. The start node never collapses – a fully resolved map would
 * otherwise draw as a single box. Nothing holding an `out-of-scope` node
 * collapses either, because what the map dropped is what a reader is sent to
 * look for.
 */
function collectDrawn(nodes: DiagramNode[], start: DiagramNode): Drawn[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const children = new Map<string, DiagramNode[]>();
  for (const node of nodes) {
    if (!node.answers) continue;
    children.set(node.answers, [...(children.get(node.answers) ?? []), node]);
  }
  for (const kids of children.values()) kids.sort((a, b) => compareIds(a.id, b.id));

  const wholly = new Map<string, boolean>();
  const whollyResolved = (id: string): boolean => {
    const known = wholly.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    const value =
      node?.status === 'resolved' && (children.get(id) ?? []).every(k => whollyResolved(k.id));
    wholly.set(id, value);
    return value;
  };
  const sizes = new Map<string, number>();
  const subtreeSize = (id: string): number => {
    const known = sizes.get(id);
    if (known !== undefined) return known;
    const value = (children.get(id) ?? []).reduce((sum, k) => sum + subtreeSize(k.id), 1);
    sizes.set(id, value);
    return value;
  };

  const drawn: Drawn[] = [];
  const visit = (node: DiagramNode, isStart: boolean): void => {
    if (!isStart && whollyResolved(node.id)) {
      drawn.push({ node, hidden: subtreeSize(node.id) - 1 });
      return;
    }
    drawn.push({ node, hidden: 0 });
    for (const kid of children.get(node.id) ?? []) visit(kid, false);
  };
  visit(start, true);
  return drawn;
}

/**
 * One node's box.
 *
 * The label carries what the drawing cannot: the count of a collapsed subtree,
 * and the ids of any blockers sitting outside the drawn subtree. Both are the
 * same move – a hold the reader has to know about, and no box to draw it
 * against, so the node it lands on names it.
 */
function nodeLine({ node, hidden }: Drawn, blockersOffMap: string[]): string {
  const [open, close] = SHAPES[node.kind];
  const parts = [`${linkedId(node)} ${node.kind} - ${node.status}`, escapeLabel(node.label)];
  if (hidden > 0) parts.push(`+${hidden} more`);
  if (blockersOffMap.length > 0) {
    parts.push(`blocked by ${blockersOffMap.map(id => `#${id}`).join(', ')}`);
  }
  return `  ${mermaidId(node.id)}${open}${parts.join('<br/>')}${close}`;
}

// ---------------------------------------------------------------------------
// The legend, drawn as its own fence
//
// The whole fence is one subgraph titled `Legend`, which is what marks where
// the legend starts and the diagram above it ends. The standing ruling against
// a subgraph is about the main diagram, where an unconnected subgraph is a
// second layout component mermaid drops wherever it likes; here the subgraph
// is the entire fence, so it has nothing to float against.
// ---------------------------------------------------------------------------

const LEGEND_SHAPE_CLASS = 'legendShape';
const LEGEND_HITL_CLASS = 'legendHitl';
const LEGEND_FRONT_CLASS = 'legendFront';

// Six boxes per row at most, and three rows at most, wrapping to a second and
// then a third chain, which mermaid lays out as further rows.
//
// The legend never overflows those bounds. Its widest possible form is one item
// per kind, one per status, both mode items, the frontier item and both edge
// items – 15 items, and the two edge items draw two boxes each, so 17 boxes
// against 18 slots. That holds while NODE_KINDS stays at five and NODE_STATUSES
// at five; a sixth of either needs one of these two numbers raised with it.
const MAX_BOXES_PER_ROW = 6;
const MAX_ROWS = 3;

interface LegendItem {
  /**
   * Every box the item draws, in draw order. An edge item draws two, joined by
   * their own visible arrow, and the invisible chain runs through both.
   */
  boxIds: string[];
  lines: string[];
  classes: Array<{ id: string; className: string }>;
  /** True on the one item drawing the `blocked-by` arrow, which the dash widens. */
  dotted?: boolean;
}

/**
 * Every way to cut `n` items into `count` non-empty runs, as items per run.
 *
 * The search this feeds is bounded by the legend's own bounds above: at most 3
 * rows over at most 15 items, so at most C(14, 2) = 91 shapes, every one of
 * them a three-element array.
 */
function partitions(n: number, count: number): number[][] {
  if (count <= 1) return n >= 1 ? [[n]] : [];
  const out: number[][] = [];
  for (let first = 1; first <= n - (count - 1); first++) {
    for (const rest of partitions(n - first, count - 1)) out.push([first, ...rest]);
  }
  return out;
}

/** The boxes each run of `shape` holds, given the boxes each item holds. */
function rowBoxes(shape: number[], boxes: number[]): number[] {
  const sizes: number[] = [];
  let at = 0;
  for (const run of shape) {
    sizes.push(boxes.slice(at, at + run).reduce((sum, n) => sum + n, 0));
    at += run;
  }
  return sizes;
}

/** How far the fullest row of a split sits above the emptiest. */
function spread(sizes: number[]): number {
  return Math.max(...sizes) - Math.min(...sizes);
}

/** Negative when `a` fills its earlier rows fuller than `b` does. */
function compareRowFullness(a: number[], b: number[]): number {
  for (let at = 0; at < a.length; at++) {
    if (a[at] !== b[at]) return b[at] - a[at];
  }
  return 0;
}

/**
 * The most even of the ways to cut the items into `count` rows: the smallest
 * spread between the fullest row and the emptiest, and among the ties the one
 * that fills the earlier rows first, so the legend reads top-heavy rather than
 * trailing off.
 */
function mostBalanced(boxes: number[], count: number): number[] | undefined {
  let best: number[] | undefined;
  let bestSizes: number[] = [];
  for (const shape of partitions(boxes.length, count)) {
    const sizes = rowBoxes(shape, boxes);
    const beats =
      !best ||
      spread(sizes) < spread(bestSizes) ||
      (spread(sizes) === spread(bestSizes) && compareRowFullness(sizes, bestSizes) < 0);
    if (beats) {
      best = shape;
      bestSizes = sizes;
    }
  }
  return best;
}

/**
 * The rows the invisible-link chains draw.
 *
 * A row holds boxes, not items, so an edge item counts as the two boxes it
 * draws and never splits across a break – its two boxes and their arrow have to
 * sit together. The legend takes as few rows as the six-box cap allows, three
 * at the outside, and spreads its boxes evenly over the rows it takes, so no
 * row is left nearly empty.
 */
function legendRows(items: LegendItem[]): LegendItem[][] {
  const boxes = items.map(i => i.boxIds.length);
  const total = boxes.reduce((sum, n) => sum + n, 0);
  const fewest = Math.min(MAX_ROWS, Math.max(1, Math.ceil(total / MAX_BOXES_PER_ROW)));
  let fallback: number[] | undefined;
  let chosen: number[] | undefined;
  for (let count = fewest; count <= MAX_ROWS && !chosen; count++) {
    const shape = mostBalanced(boxes, count);
    if (!shape) continue;
    fallback ??= shape;
    // A two-box item can push a row past the cap, and one more row is the only
    // thing that takes it back under.
    if (Math.max(...rowBoxes(shape, boxes)) <= MAX_BOXES_PER_ROW) chosen = shape;
  }
  const shape = chosen ?? fallback ?? [items.length];
  const rows: LegendItem[][] = [];
  let at = 0;
  for (const run of shape) {
    rows.push(items.slice(at, at + run));
    at += run;
  }
  return rows;
}

/**
 * One row's invisible links, which is what forces mermaid to rank its boxes
 * onto a single line.
 *
 * The chain runs through every box, not just the leading box of each item:
 * linking only the leaders ranks the first boxes together and the second boxes
 * together, which draws one row as two. An edge item's own arrow already links
 * its pair, so the invisible run stops at its first box and picks up again at
 * its last – `frontier ~~~ A`, `A --> B`, `B ~~~ C`, `C -.-> D`.
 */
function chainLines(row: LegendItem[]): string[] {
  const lines: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 1) lines.push(run.join(' ~~~ '));
  };
  for (const item of row) {
    run.push(item.boxIds[0]);
    if (item.boxIds.length > 1) {
      flush();
      run = [item.boxIds[item.boxIds.length - 1]];
    }
  }
  flush();
  return lines;
}

// Every operator mermaid counts as a link, so a line's own text says how many
// indices it consumes rather than a count derived from what drew it.
const LINK_OPERATORS = /-\.->|-->|---|~~~/g;

function linksIn(line: string): number {
  return (line.match(LINK_OPERATORS) ?? []).length;
}

/**
 * The legend's neutral swatch, borrowing the `work` shape on purpose: `work` is
 * the plainest of the five, so an item whose meaning is its fill, its stroke or
 * its arrow reads as having no shape of its own rather than as a sixth kind.
 */
function plainBox(id: string, text: string): string {
  const [open, close] = SHAPES.work;
  return `${id}${open}${text}${close}`;
}

/** Which cues the drawn diagram actually uses, and so which the legend lists. */
interface LegendCues {
  kinds: Set<NodeKind>;
  statuses: Set<NodeStatus>;
  hitl: boolean;
  frontier: boolean;
  answersEdge: boolean;
  blockedEdge: boolean;
}

/**
 * The items the legend draws, in reading order: the shapes, the fills, the mode
 * pair, the frontier outline, then the two edges.
 *
 * Only the cues the diagram uses appear – a row for an absent shape sends the
 * reader hunting for something that is not there. Every cue is drawn rather
 * than described, which is the whole reason it is a diagram, and the two terms
 * a reader may not hold carry a plain-words gloss.
 */
function legendItems(shown: LegendCues): LegendItem[] {
  const items: LegendItem[] = [];
  let counter = 0;
  const nextId = (): string => `lg${++counter}`;
  const swatch = (text: string, name: string): void => {
    const id = nextId();
    items.push({
      boxIds: [id],
      lines: [plainBox(id, text)],
      classes: [{ id, className: name }],
    });
  };

  for (const kind of NODE_KINDS) {
    if (!shown.kinds.has(kind)) continue;
    const id = nextId();
    const [open, close] = SHAPES[kind];
    items.push({
      boxIds: [id],
      lines: [`${id}${open}${kind}${close}`],
      classes: [{ id, className: LEGEND_SHAPE_CLASS }],
    });
  }

  for (const status of NODE_STATUSES) {
    if (!shown.statuses.has(status)) continue;
    swatch(status, className(status, PLAIN));
  }

  // A cue landing on almost every node carries no information, so the mode cue
  // is drawn only where a human is the one who must answer, and a map with no
  // unresolved hitl node draws no mode cue and no mode legend item at all.
  if (shown.hitl) {
    swatch('afk (agent can work alone)', LEGEND_SHAPE_CLASS);
    swatch('hitl (a human must answer)', LEGEND_HITL_CLASS);
  }

  if (shown.frontier) swatch('frontier (ready to work on)', LEGEND_FRONT_CLASS);

  // The verb goes on the edge and the boxes stay bare letters, so the sentence
  // reads in the arrow's own direction and there is nothing left to interpret.
  const edge = (from: string, to: string, arrow: string, dotted?: true): void => {
    const fromId = nextId();
    const toId = nextId();
    items.push({
      boxIds: [fromId, toId],
      lines: [`${plainBox(fromId, from)} ${arrow} ${plainBox(toId, to)}`],
      dotted,
      classes: [
        { id: fromId, className: LEGEND_SHAPE_CLASS },
        { id: toId, className: LEGEND_SHAPE_CLASS },
      ],
    });
  };
  if (shown.answersEdge) edge('A', 'B', '-->|"A surfaced B"|');
  if (shown.blockedEdge) edge('C', 'D', '-.->|"C must finish before D"|', true);

  return items;
}

/**
 * The legend's classDefs. Every stroke a cue draws comes from `cueStroke`, so
 * the legend shows what the diagram shows; only the neutral swatch is stated
 * here, because "no cue at all" is a flat outline rather than a cue.
 */
function legendClassDefs(shown: LegendCues): string[] {
  const defs = [
    `  classDef ${LEGEND_SHAPE_CLASS} fill:${LEGEND_FILL},color:${TEXT_COLOUR},stroke:${NEUTRAL_STROKE}`,
    ...NODE_STATUSES.filter(status => shown.statuses.has(status)).map(status =>
      classDefLine(status, PLAIN)
    ),
  ];
  const cueDef = (name: string, cue: Cue): string =>
    `  classDef ${name} fill:${LEGEND_FILL},color:${TEXT_COLOUR},` +
    cueStroke(cue, LEGEND_FILL).join(',');
  if (shown.hitl) defs.push(cueDef(LEGEND_HITL_CLASS, HITL_ONLY));
  if (shown.frontier) defs.push(cueDef(LEGEND_FRONT_CLASS, FRONTIER_ONLY));
  return defs;
}

/**
 * The legend body: every row's boxes, then that row's own chain, and the
 * `linkStyle` naming the blocked-by arrow.
 *
 * Dagre orders disconnected components by the order their first link is
 * declared, never by the order their first node is. Emitting every box before
 * any chain therefore let the row holding the edge items - always the last
 * row - own the first link in the file, and dagre hoisted it to the top. Each
 * row now emits its own boxes and then its own chain, so declaration order and
 * link order are the same thing, which is the order the reader sees.
 *
 * That interleaving moves the link indices, so the `linkStyle` naming the
 * blocked-by edge counts links in emission order. The count is read off the
 * emitted lines themselves through `linksIn`, never off what an item is made
 * of: an item drawing an edge happens to declare exactly one link today, and a
 * proxy that is only right by coincidence fails silently - the dash lands on
 * the wrong arrow and the fence still renders. The legend restates the
 * diagram's own widened dash on that arrow, so the two show the same line.
 */
function legendBody(items: LegendItem[]): { body: string[]; blockedStyle: string[] } {
  const body: string[] = [];
  const blockedStyle: string[] = [];
  let declared = 0;
  const emit = (line: string): void => {
    body.push(line);
    declared += linksIn(line);
  };
  for (const row of legendRows(items)) {
    for (const item of row) {
      if (item.dotted) blockedStyle.push(`  linkStyle ${declared} ${BLOCKED_DASH}`);
      for (const line of item.lines) emit(line);
    }
    for (const line of chainLines(row)) emit(line);
  }
  return { body, blockedStyle };
}

/** The `class` lines binding every item's boxes to the classDefs above. */
function classAssignments(items: LegendItem[]): string[] {
  const byClass = new Map<string, string[]>();
  for (const item of items) {
    for (const { id, className: name } of item.classes) {
      byClass.set(name, [...(byClass.get(name) ?? []), id]);
    }
  }
  return [...byClass.entries()].map(([name, ids]) => `  class ${ids.join(',')} ${name}`);
}

function renderLegend(shown: LegendCues): string[] {
  const items = legendItems(shown);
  const { body, blockedStyle } = legendBody(items);
  return [
    'flowchart LR',
    '  subgraph Legend["Legend"]',
    '    direction LR',
    ...body.map(line => `    ${line}`),
    '  end',
    ...blockedStyle,
    ...legendClassDefs(shown),
    ...classAssignments(items),
  ];
}

// ---------------------------------------------------------------------------
// The main fence
// ---------------------------------------------------------------------------

/**
 * The two edge kinds, kept apart because mermaid styles an edge by its
 * declaration index and the blocked-by run has to be nameable.
 *
 * Both arrows point the same way: the source comes first in time, the target
 * second. Nothing on the diagram ever points backwards. An edge is drawn only
 * when the drawn subtree holds both its ends.
 */
interface Edges {
  answers: string[];
  blocked: string[];
}

function buildEdges(drawn: Drawn[], start: DiagramNode, drawnIds: Set<string>): Edges {
  const edges: Edges = { answers: [], blocked: [] };
  for (const { node } of drawn) {
    if (node.id !== start.id && node.answers && drawnIds.has(node.answers)) {
      edges.answers.push(`  ${mermaidId(node.answers)} --> ${mermaidId(node.id)}`);
    }
    for (const blocker of node.blockedBy) {
      if (drawnIds.has(blocker)) {
        edges.blocked.push(`  ${mermaidId(blocker)} -.-> ${mermaidId(node.id)}`);
      }
    }
  }
  return edges;
}

// The blocking edges are declared in one run, after every answers edge and
// after nothing else, so their indices are the answers count and up.
function blockedLinkStyle(edges: Edges): string[] {
  if (edges.blocked.length === 0) return [];
  const named = edges.blocked.map((_edge, at) => edges.answers.length + at).join(',');
  return [`  linkStyle ${named} ${BLOCKED_DASH}`];
}

/** The blockers of each drawn node that the drawn subtree does not hold. */
function blockersOffMap(drawn: Drawn[], drawnIds: Set<string>): Map<string, string[]> {
  const off = new Map<string, string[]>();
  for (const { node } of drawn) {
    const outside = node.blockedBy.filter(blocker => !drawnIds.has(blocker));
    if (outside.length > 0) off.set(node.id, outside);
  }
  return off;
}

interface ClassGroup {
  status: NodeStatus;
  cue: Cue;
  ids: string[];
}

/**
 * One class per node, so the precedence between the frontier outline and the
 * mode border is settled here rather than left to mermaid. Groups come back in
 * cue-rank order, since mermaid resolves a stroke collision by source order and
 * every frontier classDef has to be emitted after the ones it beats.
 */
function groupByClass(
  drawn: Drawn[],
  cueOf: (node: DiagramNode) => Cue
): Array<[string, ClassGroup]> {
  const members = new Map<string, ClassGroup>();
  for (const { node } of drawn) {
    const cue = cueOf(node);
    const name = className(node.status, cue);
    const group = members.get(name) ?? { status: node.status, cue, ids: [] };
    group.ids.push(mermaidId(node.id));
    members.set(name, group);
  }
  return [...members.entries()].sort((a, b) => cueRank(a[1].cue) - cueRank(b[1].cue));
}

/**
 * The whole rendered block: the marker comments around a main fence and a
 * legend fence.
 */
export function renderDiagram(nodes: DiagramNode[], options: RenderOptions = {}): string {
  if (nodes.length === 0) {
    throw new Error('the map has no nodes – there is nothing to draw');
  }
  const start = resolveStart(nodes, options.from);
  // Validates the provenance chain and every blocking reference, then hands
  // back the nodes ready to be worked now.
  const onFrontier = new Set(frontier(asMapNodes(nodes)).map(n => n.id));
  const drawn = collectDrawn(nodes, start);
  const drawnIds = new Set(drawn.map(d => d.node.id));

  const cueOf = (node: DiagramNode): Cue => ({
    frontier: onFrontier.has(node.id),
    // Mode says who will settle a node, and nobody will settle a settled one.
    // The border marks hitl rather than afk, because a human answering is the
    // scarce case and the one a reader is hunting for.
    hitl: node.mode === 'hitl' && !isSettled(node.status),
  });

  const edges = buildEdges(drawn, start, drawnIds);
  const offMap = blockersOffMap(drawn, drawnIds);
  const groups = groupByClass(drawn, cueOf);

  const main = [
    'flowchart TD',
    ...drawn.map(entry => nodeLine(entry, offMap.get(entry.node.id) ?? [])),
    ...edges.answers,
    ...edges.blocked,
    ...blockedLinkStyle(edges),
    ...groups.map(([, group]) => classDefLine(group.status, group.cue)),
    ...groups.map(([name, group]) => `  class ${group.ids.join(',')} ${name}`),
  ];

  const legend = renderLegend({
    kinds: new Set(drawn.map(d => d.node.kind)),
    statuses: new Set(drawn.map(d => d.node.status)),
    hitl: drawn.some(d => cueOf(d.node).hitl),
    frontier: drawn.some(d => cueOf(d.node).frontier),
    answersEdge: edges.answers.length > 0,
    blockedEdge: edges.blocked.length > 0,
  });

  return [
    DIAGRAM_START,
    '',
    '```mermaid',
    ...main,
    '```',
    '',
    '```mermaid',
    ...legend,
    '```',
    '',
    DIAGRAM_END,
  ].join('\n');
}
