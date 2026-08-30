// The files backend for map nodes: spechub/maps/<name>/NNN-slug.md.
//
// This module is the whole tracker contract for the files backend – create,
// read, update, list. Frontier, claim and resolve are compositions over these
// and live in the skills, not here.
//
// One file per node, no map.md, no index. The map is queries over the nodes.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { replaceFileAtomically } from './atomic-file.js';
import { SPECHUB_DIR, MAPS_DIR } from './constants.js';
import { ensureDir } from './utils.js';

export const NODE_STATUSES = ['fog', 'open', 'claimed', 'resolved', 'out-of-scope'] as const;
export const NODE_MODES = ['hitl', 'afk'] as const;
// kind is a closed set: a diagram renderer will switch on it to pick a shape,
// so an unknown value would have no drawing and the legend could not enumerate
// itself. See docs/adr/0012-node-kind-is-a-closed-set-of-five.md.
export const NODE_KINDS = ['destination', 'notes', 'decision', 'research', 'work'] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];
export type NodeMode = (typeof NODE_MODES)[number];
export type NodeKind = (typeof NODE_KINDS)[number];

// The label is what a diagram draws, so it is capped hard. An uncapped field
// drifts back into a full title within a few rounds, and the diagram stops
// being readable.
export const LABEL_MAX_WORDS = 4;
export const LABEL_MAX_CHARS = 30;
// The one sentence that states the caps in prose. Every help string and every
// "label is required" message reads it, so the numbers and the wording both
// have a single home.
export const LABEL_CAP_SENTENCE = `at most ${LABEL_MAX_WORDS} words and ${LABEL_MAX_CHARS} characters`;
// The one sentence that names the five kinds. Every help string and every "kind
// is not allowed" message reads it, on both backends, so the wording and the
// separator before it cannot drift apart.
export const ALLOWED_KINDS_SENTENCE = `one of: ${NODE_KINDS.join(', ')}`;

/**
 * A node the map is done with. Mode says who will settle a node, and nobody
 * will settle a settled one, so the frontier and the diagram's mode cue both
 * ask this rather than each listing the two settled statuses.
 */
export function isSettled(status: NodeStatus): boolean {
  return status === 'resolved' || status === 'out-of-scope';
}

/**
 * The one sentence both `walkTree` and the diagram refuse a rootless or
 * many-rooted map with.
 */
export function rootCountError(roots: number): string {
  return `map has ${roots} roots – expected exactly one`;
}

export interface MapNode {
  id: string; // zero-padded number, identity only – never order
  title: string;
  status: NodeStatus;
  mode: NodeMode;
  kind: NodeKind;
  label: string; // short name for drawing – see LABEL_MAX_WORDS and LABEL_MAX_CHARS
  answers?: string; // provenance parent id; absent only on the root
  blockedBy: string[];
  pinned: boolean;
  body: string; // markdown after the title heading
  file: string; // filename within the map directory
}

export interface CreateNodeInput {
  title: string;
  status?: NodeStatus;
  mode?: NodeMode;
  kind: NodeKind;
  label: string;
  answers?: string;
  blockedBy?: string[];
  pinned?: boolean;
  body?: string;
}

export interface UpdateNodeInput {
  title?: string;
  status?: NodeStatus;
  mode?: NodeMode;
  kind?: NodeKind; // no clear path – every node has a kind
  label?: string;
  answers?: string;
  blockedBy?: string[];
  pinned?: boolean;
  body?: string;
  appendBody?: string;
}

// YAML reads an unquoted `answers: 001` as the number 1, so ids are coerced
// back to zero-padded strings on the way in.
const idValue = z
  .union([z.string(), z.number()])
  .transform(v => normalizeId(String(v)))
  .pipe(z.string().regex(/^\d{3,}$/, 'node id must be a number'));

const frontmatterSchema = z.object({
  status: z.enum(NODE_STATUSES),
  mode: z.enum(NODE_MODES),
  kind: z.enum(NODE_KINDS),
  // A stored label is held to the same caps as one arriving through create or
  // update – the file is the only place a hand-edit can slip a long one in. It
  // trims before it checks and yields the trimmed value, so what passed the
  // caps is also what the node carries.
  label: z
    .string()
    .transform(value => value.trim())
    .superRefine((trimmed, ctx) => {
      const problem = labelCapProblem(trimmed);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
  answers: idValue.optional(),
  'blocked-by': z.array(idValue).default([]),
  pinned: z.boolean().default(false),
});

export function normalizeId(id: string): string {
  const trimmed = id.trim();
  if (!/^\d+$/.test(trimmed)) return trimmed;
  return trimmed.padStart(3, '0');
}

/**
 * An id as a reader may have copied it out of a diagram or an issue title –
 * `#12` – as the bare id. Padding is `normalizeId`'s job, not this one's.
 */
export function bareId(reference: string): string {
  return reference.trim().replace(/^#/, '');
}

export function mapDir(root: string, map: string): string {
  return join(root, SPECHUB_DIR, MAPS_DIR, map);
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/, '') || 'node'
  );
}

// Titles become the `# ` heading line, so they must be one non-empty line.
function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error('title must not be empty');
  }
  if (/[\r\n]/.test(title)) {
    throw new Error('title must be a single line');
  }
  return trimmed;
}

// kind and label reach here from callers that can dodge the compile-time types
// – CLI flags, a hand-written file, a cast – so both are checked at runtime, and
// the error names the offending value beside what was allowed.
function validateKind(kind: unknown): NodeKind {
  if (typeof kind !== 'string' || !(NODE_KINDS as readonly string[]).includes(kind)) {
    const shown = kind === undefined ? 'is missing' : `${JSON.stringify(kind)} is not allowed`;
    throw new Error(`kind ${shown} – ${ALLOWED_KINDS_SENTENCE}`);
  }
  return kind as NodeKind;
}

// The cap is on what a reader sees, so it counts graphemes rather than UTF-16
// code units: a family emoji is one drawn character and so is an accented
// letter typed as a letter plus a combining mark. Intl.Segmenter is the only
// thing in the platform that knows where a grapheme ends; code points are the
// closest a runtime without it can get.
const graphemes =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined;

function countCharacters(text: string): number {
  if (!graphemes) return [...text].length;
  return [...graphemes.segment(text)].length;
}

// The one place every label rule is applied. The frontmatter schema,
// validateLabel below and the github adapter all run a trimmed label through
// this, so none restates a number, none holds a rule the others miss, and a
// stored file fails the same way a rejected flag or a bad issue header does.
export function labelCapProblem(trimmed: string): string | undefined {
  if (!trimmed) return 'must not be empty';
  if (/[\r\n]/.test(trimmed)) return 'must be a single line';
  const words = trimmed.split(/\s+/);
  if (words.length > LABEL_MAX_WORDS) {
    return `is ${words.length} words – the cap is ${LABEL_MAX_WORDS}`;
  }
  const characters = countCharacters(trimmed);
  if (characters > LABEL_MAX_CHARS) {
    return `is ${characters} characters – the cap is ${LABEL_MAX_CHARS}`;
  }
  return undefined;
}

// Labels are trimmed on the way in, so surrounding whitespace never reaches the
// file and never counts toward the word cap.
function validateLabel(label: unknown): string {
  // Absent and supplied-but-wrong read differently, the way validateKind above
  // separates them. A blank label was supplied, so it is refused below by the
  // same sentence a stored blank gets, not reported as missing.
  if (typeof label !== 'string') {
    const shown = label === undefined ? 'is required' : `${JSON.stringify(label)} is not allowed`;
    throw new Error(`label ${shown} – ${LABEL_CAP_SENTENCE}`);
  }
  const trimmed = label.trim();
  const problem = labelCapProblem(trimmed);
  // The flag paths quote the offending label, which the schema path cannot.
  if (problem) throw new Error(`label "${trimmed}" ${problem}`);
  return trimmed;
}

/**
 * Ids compared as a reader writes them.
 *
 * Two all-digit ids compare numerically, so `2`, `002` and `0002` are one id
 * and zero-padding stops mattering past 999. That is what lets `--from` take an
 * id copied out of either backend. Anything else falls back to text order,
 * which is the only order a non-numeric id has.
 */
export function compareIds(a: string, b: string): number {
  const left = a.trim();
  const right = b.trim();
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return parseInt(left, 10) - parseInt(right, 10);
  }
  return left.localeCompare(right);
}

// kind and label were added after the first maps were written, so a file
// missing one is not corrupt – it is older than the field. Map nodes are
// transient working state a map throws away at archive, so there is nothing to
// migrate and nothing to repair: the map itself is what to discard.
const FIELDS_ADDED_AFTER_THE_FIRST_MAPS: readonly string[] = ['kind', 'label'];

function frontmatterProblem(issue: z.ZodIssue): string {
  const field = String(issue.path[0] ?? '');
  if (
    issue.code === z.ZodIssueCode.invalid_type &&
    issue.received === 'undefined' &&
    FIELDS_ADDED_AFTER_THE_FIRST_MAPS.includes(field)
  ) {
    return (
      `${field} is missing – this file predates the ${field} field. Map nodes are ` +
      'transient working state, so discard this map and chart a new one rather than repairing it.'
    );
  }
  return `${issue.path.join('.')} ${issue.message}`;
}

function parseNodeFile(dir: string, file: string): MapNode {
  const raw = readFileSync(join(dir, file), 'utf-8').replace(/\r\n/g, '\n');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`${file}: missing frontmatter`);
  }
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]);
  } catch (err) {
    // A YAML error names a line and a column but not the file, and label is the
    // first free-text quoted value a hand-edit can leave unbalanced.
    throw new Error(`${file}: ${(err as Error).message}`);
  }
  const parsed = frontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    throw new Error(`${file}: ${frontmatterProblem(parsed.error.issues[0])}`);
  }
  // The title must be the first non-blank line after the frontmatter –
  // scanning further would let a `# ` line inside the body win, and would
  // silently drop any content sitting above the real heading.
  const rest = match[2].replace(/^\n+/, '');
  const newline = rest.indexOf('\n');
  const firstLine = newline === -1 ? rest : rest.slice(0, newline);
  const titleMatch = firstLine.match(/^# (.+)$/);
  if (!titleMatch) {
    throw new Error(`${file}: the first line after the frontmatter must be the "# title" heading`);
  }
  const body = newline === -1 ? '' : rest.slice(newline + 1);
  const idMatch = file.match(/^(\d+)/);
  if (!idMatch) {
    throw new Error(`${file}: filename must start with the node number`);
  }
  return {
    id: normalizeId(idMatch[1]),
    title: titleMatch[1].trim(),
    status: parsed.data.status,
    mode: parsed.data.mode,
    kind: parsed.data.kind,
    label: parsed.data.label,
    answers: parsed.data.answers,
    blockedBy: parsed.data['blocked-by'],
    pinned: parsed.data.pinned,
    body: body.replace(/^\n+/, '').replace(/\n+$/, ''),
    file,
  };
}

export function loadNodes(root: string, map: string): MapNode[] {
  const dir = mapDir(root, map);
  if (!existsSync(dir)) return [];
  const nodes = readdirSync(dir)
    .filter(f => /^\d+.*\.md$/.test(f))
    .map(f => parseNodeFile(dir, f))
    .sort((a, b) => compareIds(a.id, b.id));
  const seen = new Map<string, string>();
  for (const node of nodes) {
    const other = seen.get(node.id);
    if (other) {
      throw new Error(`duplicate node id ${node.id}: ${other} and ${node.file}`);
    }
    seen.set(node.id, node.file);
  }
  return nodes;
}

export function getNode(root: string, map: string, id: string): MapNode {
  const normalized = normalizeId(id);
  const node = loadNodes(root, map).find(n => n.id === normalized);
  if (!node) {
    throw new Error(`node ${normalized} not found in map '${map}'`);
  }
  return node;
}

function serializeNode(node: MapNode): string {
  const lines = [
    '---',
    `status: ${node.status}`,
    `mode: ${node.mode}`,
    // The five kinds are plain YAML identifiers and need no quoting. A label
    // is free text, and JSON quoting keeps a colon or a quote inside one from
    // corrupting the YAML.
    `kind: ${node.kind}`,
    `label: ${JSON.stringify(node.label)}`,
  ];
  if (node.answers) lines.push(`answers: "${node.answers}"`);
  lines.push(
    node.blockedBy.length > 0
      ? `blocked-by: [${node.blockedBy.map(b => `"${b}"`).join(', ')}]`
      : 'blocked-by: []'
  );
  if (node.pinned) lines.push('pinned: true');
  lines.push('---', '', `# ${node.title}`);
  // Strip only newlines – trimming spaces would de-indent a body that
  // opens with indented markdown.
  const body = node.body.replace(/^\n+/, '').replace(/\n+$/, '');
  if (body) lines.push('', body);
  return lines.join('\n') + '\n';
}

function writeNode(root: string, map: string, node: MapNode): void {
  const dir = mapDir(root, map);
  ensureDir(dir);
  // Every command loads the whole map and throws on the first file it cannot
  // parse, so one interrupted write would take the map down, not one node.
  replaceFileAtomically(join(dir, node.file), serializeNode(node));
}

function requireExisting(nodes: MapNode[], id: string, role: string): void {
  if (!nodes.some(n => n.id === id)) {
    throw new Error(`${role} node ${id} does not exist`);
  }
}

export function createNode(root: string, map: string, input: CreateNodeInput): MapNode {
  const title = validateTitle(input.title);
  const kind = validateKind(input.kind);
  const label = validateLabel(input.label);
  const nodes = loadNodes(root, map);
  const answers = input.answers ? normalizeId(input.answers) : undefined;
  const blockedBy = (input.blockedBy ?? []).map(normalizeId);

  if (nodes.length === 0 && answers) {
    throw new Error(`map '${map}' is empty – the first node is the root and takes no --answers`);
  }
  if (nodes.length > 0 && !answers) {
    throw new Error(`map '${map}' already has a root – every other node needs --answers <id>`);
  }
  if (answers) requireExisting(nodes, answers, 'parent');
  for (const b of blockedBy) requireExisting(nodes, b, 'blocking');

  const maxId = nodes.reduce((max, n) => Math.max(max, parseInt(n.id, 10)), 0);
  const id = String(maxId + 1).padStart(3, '0');
  const node: MapNode = {
    id,
    title,
    status: input.status ?? 'open',
    mode: input.mode ?? 'hitl',
    kind,
    label,
    answers,
    blockedBy,
    pinned: input.pinned ?? false,
    body: input.body ?? '',
    file: `${id}-${slugify(title)}.md`,
  };
  writeNode(root, map, node);
  return node;
}

export function updateNode(
  root: string,
  map: string,
  id: string,
  input: UpdateNodeInput
): MapNode {
  const nodes = loadNodes(root, map);
  const normalized = normalizeId(id);
  const node = nodes.find(n => n.id === normalized);
  if (!node) {
    throw new Error(`node ${normalized} not found in map '${map}'`);
  }

  if (input.answers !== undefined) {
    const parent = normalizeId(input.answers);
    if (!node.answers) {
      throw new Error(`node ${node.id} is the root – it cannot gain a parent`);
    }
    if (parent === node.id) {
      throw new Error(`node ${node.id} cannot answer itself`);
    }
    requireExisting(nodes, parent, 'parent');
    // Walking up from the new parent must not reach this node.
    const byId = new Map(nodes.map(n => [n.id, n]));
    let cursor: string | undefined = parent;
    while (cursor) {
      if (cursor === node.id) {
        throw new Error(`answers: ${parent} would make the provenance tree a cycle`);
      }
      cursor = byId.get(cursor)?.answers;
    }
    node.answers = parent;
  }

  if (input.blockedBy !== undefined) {
    const blockedBy = input.blockedBy.map(normalizeId);
    for (const b of blockedBy) {
      if (b === node.id) throw new Error(`node ${node.id} cannot block itself`);
      requireExisting(nodes, b, 'blocking');
    }
    // blocked-by must stay a DAG – a cycle would deadlock every node on it,
    // silently, since the frontier only ever sees unresolved blockers.
    node.blockedBy = blockedBy;
    const byId = new Map(nodes.map(n => [n.id, n]));
    const walk = (id: string, trail: Set<string>): void => {
      if (trail.has(id)) {
        throw new Error(`blocked-by cycle through node ${id} – these nodes would block each other forever`);
      }
      trail.add(id);
      for (const b of byId.get(id)?.blockedBy ?? []) walk(b, trail);
      trail.delete(id);
    };
    walk(node.id, new Set());
  }

  if (input.title !== undefined) node.title = validateTitle(input.title);
  if (input.status !== undefined) node.status = input.status;
  if (input.mode !== undefined) node.mode = input.mode;
  if (input.kind !== undefined) node.kind = validateKind(input.kind);
  if (input.label !== undefined) node.label = validateLabel(input.label);
  if (input.pinned !== undefined) node.pinned = input.pinned;
  if (input.body !== undefined) node.body = input.body;
  if (input.appendBody !== undefined) {
    node.body = node.body.trim() ? node.body.trim() + '\n\n' + input.appendBody : input.appendBody;
  }

  writeNode(root, map, node);
  return node;
}

// Depth is derived from the answers chain, never declared. Root is 0.
// Hand-edited maps can hold a missing parent or a cycle, so both throw
// with the node named rather than looping or guessing.
export function deriveDepths(nodes: MapNode[]): Map<string, number> {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const depths = new Map<string, number>();

  function depthOf(id: string, trail: Set<string>): number {
    const known = depths.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) {
      throw new Error(`node ${id}: provenance cycle in answers chain`);
    }
    trail.add(id);
    const node = byId.get(id);
    if (!node) {
      throw new Error(`node ${id} is referenced but does not exist`);
    }
    let depth = 0;
    if (node.answers) {
      if (!byId.has(node.answers)) {
        throw new Error(`node ${id}: parent ${node.answers} does not exist`);
      }
      depth = depthOf(node.answers, trail) + 1;
    }
    depths.set(id, depth);
    return depth;
  }

  for (const node of nodes) depthOf(node.id, new Set());
  return depths;
}

// The frontier: open nodes with no unresolved blockers, shallowest
// provenance depth first, node number only as a stable final tiebreak.
// A blocker blocks unless it is resolved or out-of-scope – fog and
// claimed both still block, since neither is settled.
export function frontier(nodes: MapNode[]): MapNode[] {
  const depths = deriveDepths(nodes);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const blockerSettled = (id: string): boolean => {
    const blocker = byId.get(id);
    if (!blocker) {
      throw new Error(`blocking node ${id} is referenced but does not exist`);
    }
    return isSettled(blocker.status);
  };
  return nodes
    .filter(n => n.status === 'open' && n.blockedBy.every(blockerSettled))
    .sort((a, b) => {
      const byDepth = (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0);
      return byDepth !== 0 ? byDepth : compareIds(a.id, b.id);
    });
}

// The packaging walk: preorder over the provenance tree, children in id
// order. The walk is the reading order and the handoff – it emits every
// node regardless of mode or depth, never filtering on leaf position.
export function walkTree(nodes: MapNode[]): Array<{ node: MapNode; depth: number }> {
  deriveDepths(nodes); // validates parents exist and the chain is acyclic
  const roots = nodes.filter(n => !n.answers);
  if (nodes.length === 0) return [];
  if (roots.length !== 1) {
    throw new Error(rootCountError(roots.length));
  }
  const children = new Map<string, MapNode[]>();
  for (const node of nodes) {
    if (!node.answers) continue;
    const siblings = children.get(node.answers) ?? [];
    siblings.push(node);
    children.set(node.answers, siblings);
  }
  const out: Array<{ node: MapNode; depth: number }> = [];
  const visit = (node: MapNode, depth: number): void => {
    out.push({ node, depth });
    const kids = (children.get(node.id) ?? []).sort((a, b) => compareIds(a.id, b.id));
    for (const kid of kids) visit(kid, depth + 1);
  };
  visit(roots[0], 0);
  return out;
}
