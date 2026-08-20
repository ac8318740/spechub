// The files backend for map nodes: spechub/maps/<name>/NNN-slug.md.
//
// This module is the whole tracker contract for the files backend – create,
// read, update, list. Frontier, claim and resolve are compositions over these
// and live in the skills, not here.
//
// One file per node, no map.md, no index. The map is queries over the nodes.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { SPECHUB_DIR, MAPS_DIR } from './constants.js';
import { ensureDir } from './utils.js';

export const NODE_STATUSES = ['fog', 'open', 'claimed', 'resolved', 'out-of-scope'] as const;
export const NODE_MODES = ['hitl', 'afk'] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];
export type NodeMode = (typeof NODE_MODES)[number];

export interface MapNode {
  id: string; // zero-padded number, identity only – never order
  title: string;
  status: NodeStatus;
  mode: NodeMode;
  kind?: string;
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
  kind?: string;
  answers?: string;
  blockedBy?: string[];
  pinned?: boolean;
  body?: string;
}

export interface UpdateNodeInput {
  title?: string;
  status?: NodeStatus;
  mode?: NodeMode;
  kind?: string | null; // null clears
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
  kind: z.string().optional(),
  answers: idValue.optional(),
  'blocked-by': z.array(idValue).default([]),
  pinned: z.boolean().default(false),
});

export function normalizeId(id: string): string {
  const trimmed = id.trim();
  if (!/^\d+$/.test(trimmed)) return trimmed;
  return trimmed.padStart(3, '0');
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

// Ids are compared numerically – zero-padding stops helping past 999.
function compareIds(a: string, b: string): number {
  return parseInt(a, 10) - parseInt(b, 10);
}

function parseNodeFile(dir: string, file: string): MapNode {
  const raw = readFileSync(join(dir, file), 'utf-8').replace(/\r\n/g, '\n');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`${file}: missing frontmatter`);
  }
  const parsed = frontmatterSchema.safeParse(parseYaml(match[1]));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${file}: ${issue.path.join('.')} ${issue.message}`);
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
  const lines = ['---', `status: ${node.status}`, `mode: ${node.mode}`];
  // kind is free text – JSON quoting keeps values like "true" or "a: b"
  // from corrupting the YAML.
  if (node.kind) lines.push(`kind: ${JSON.stringify(node.kind)}`);
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
  writeFileSync(join(dir, node.file), serializeNode(node), 'utf-8');
}

function requireExisting(nodes: MapNode[], id: string, role: string): void {
  if (!nodes.some(n => n.id === id)) {
    throw new Error(`${role} node ${id} does not exist`);
  }
}

export function createNode(root: string, map: string, input: CreateNodeInput): MapNode {
  const title = validateTitle(input.title);
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
    kind: input.kind,
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
  if (input.kind !== undefined) node.kind = input.kind ?? undefined;
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
  const settled = (id: string): boolean => {
    const blocker = byId.get(id);
    if (!blocker) {
      throw new Error(`blocking node ${id} is referenced but does not exist`);
    }
    return blocker.status === 'resolved' || blocker.status === 'out-of-scope';
  };
  return nodes
    .filter(n => n.status === 'open' && n.blockedBy.every(settled))
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
    throw new Error(`map has ${roots.length} roots – expected exactly one`);
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
