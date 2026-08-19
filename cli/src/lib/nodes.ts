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

function parseNodeFile(dir: string, file: string): MapNode {
  const raw = readFileSync(join(dir, file), 'utf-8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`${file}: missing frontmatter`);
  }
  const parsed = frontmatterSchema.safeParse(parseYaml(match[1]));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${file}: ${issue.path.join('.')} ${issue.message}`);
  }
  const rest = match[2];
  const titleMatch = rest.match(/^\s*# (.+)$/m);
  if (!titleMatch) {
    throw new Error(`${file}: missing title heading`);
  }
  const body = rest.slice((titleMatch.index ?? 0) + titleMatch[0].length).replace(/^\n+/, '');
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
    body: body.replace(/\n+$/, '\n').replace(/^\n$/, ''),
    file,
  };
}

export function loadNodes(root: string, map: string): MapNode[] {
  const dir = mapDir(root, map);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^\d+.*\.md$/.test(f))
    .map(f => parseNodeFile(dir, f))
    .sort((a, b) => a.id.localeCompare(b.id));
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
  if (node.kind) lines.push(`kind: ${node.kind}`);
  if (node.answers) lines.push(`answers: "${node.answers}"`);
  lines.push(
    node.blockedBy.length > 0
      ? `blocked-by: [${node.blockedBy.map(b => `"${b}"`).join(', ')}]`
      : 'blocked-by: []'
  );
  if (node.pinned) lines.push('pinned: true');
  lines.push('---', '', `# ${node.title}`);
  const body = node.body.trim();
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
    title: input.title,
    status: input.status ?? 'open',
    mode: input.mode ?? 'hitl',
    kind: input.kind,
    answers,
    blockedBy,
    pinned: input.pinned ?? false,
    body: input.body ?? '',
    file: `${id}-${slugify(input.title)}.md`,
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
    node.blockedBy = blockedBy;
  }

  if (input.title !== undefined) node.title = input.title;
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
      return byDepth !== 0 ? byDepth : a.id.localeCompare(b.id);
    });
}

export function listMaps(root: string): string[] {
  const dir = join(root, SPECHUB_DIR, MAPS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}
