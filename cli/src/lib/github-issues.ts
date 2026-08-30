// The github backend: `gh issue list --json number,title,body,state,stateReason,labels,url`
// in, the nodes the renderer draws out.
//
// This lives apart from the renderer on purpose. Renderer purity is the
// load-bearing property – see docs/adr/0012-the-diagram-renderer-is-pure.md –
// and a module boundary states it structurally, where a comment inside one file
// only asks. diagram.ts imports nothing from here.
//
// Everything arriving here is a JSON payload from a subprocess, so every field
// is checked before it is read. A raw TypeError names neither the issue nor the
// field, which is the whole reason the shape is checked rather than tripped
// over, and every message names the issue it came from.
import {
  ALLOWED_KINDS_SENTENCE,
  NODE_KINDS,
  bareId,
  labelCapProblem,
  type NodeKind,
  type NodeStatus,
} from './nodes.js';
import type { DiagramNode } from './diagram.js';

const HEADER_SEPARATOR = '·';
const KIND_LABEL_PREFIX = 'kind:';

// The five fields the header grammar names – see
// docs/adr/0010-node-header-is-the-edge-encoding.md.
const HEADER_FIELDS = ['map', 'root', 'answers', 'blocked-by', 'label'] as const;

// `label:` runs on past a middle dot, to the next field the grammar names or to
// the end of the line, whichever comes first.
//
// Only the label needs this. Every other field holds ids, which carry no
// separator, while a label is free text and a middle dot is ordinary English
// punctuation inside one - splitting the line on every dot truncated `A · B` at
// the dot. Running to the end of the line instead is not enough either: real
// headers write `label:` in the middle, with `blocked-by:` after it, and a
// label that swallowed the rest would take every blocking edge with it.
const LABEL_FIELD = /(^|·)\s*label\s*:\s*/i;
const FIELD_AFTER_LABEL = new RegExp(`·\\s*(?:${HEADER_FIELDS.join('|')})\\s*:`, 'i');

function firstNonBlankLine(body: string): string {
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim()) return line.trim();
  }
  return '';
}

/**
 * The body header, which carries the node's whole place in the map:
 *
 *   map: <name> · root: #12 · answers: #19 · blocked-by: #14, #17 · label: Short name
 *
 * Fields come back keyed by their lowercased name, in whatever order the header
 * wrote them.
 */
function parseHeader(line: string): Map<string, string> | undefined {
  if (!/^map\s*:/i.test(line)) return undefined;
  const fields = new Map<string, string>();
  // The header opens with `map:`, so a `label:` field never sits at index 0 and
  // the fields before it are always a non-empty stretch of the line.
  let head = line;
  const label = LABEL_FIELD.exec(line);
  if (label) {
    const after = line.slice(label.index + label[0].length);
    const next = FIELD_AFTER_LABEL.exec(after);
    fields.set('label', (next ? after.slice(0, next.index) : after).trim());
    head = line.slice(0, label.index) + (next ? after.slice(next.index) : '');
  }
  for (const part of head.split(HEADER_SEPARATOR)) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    fields.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  return fields;
}

/** What a value is, for a message about a field holding the wrong kind of thing. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The labels an issue carries, as a set of names.
 *
 * gh emits `[{"name": "kind:work"}, ...]`, and anything else here means the
 * payload did not come from `gh issue list --json labels`.
 */
function labelsOf(named: string, raw: unknown): Set<string> {
  if (raw === undefined || raw === null) return new Set();
  if (!Array.isArray(raw)) {
    throw new Error(
      `${named}: labels is ${describe(raw)}, not the array of {name} objects ` +
        '`gh issue list --json labels` emits'
    );
  }
  const names = new Set<string>();
  raw.forEach((entry, at) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(
        `${named}: labels[${at}] is ${describe(entry)}, not a {name} object`
      );
    }
    const name = (entry as { name?: unknown }).name;
    if (name !== undefined && name !== null && typeof name !== 'string') {
      throw new Error(`${named}: labels[${at}].name is ${describe(name)}, not a string`);
    }
    if (name) names.add(name);
  });
  return names;
}

function bodyOf(named: string, raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new Error(`${named}: body is ${describe(raw)}, not the markdown text gh emits`);
  }
  return raw;
}

function issueStatus(state: string, stateReason: string, labels: Set<string>): NodeStatus {
  if (state.toUpperCase() === 'CLOSED') {
    return stateReason.toUpperCase() === 'NOT_PLANNED' ? 'out-of-scope' : 'resolved';
  }
  if (labels.has('fog')) return 'fog';
  if (labels.has('claimed')) return 'claimed';
  return 'open';
}

/**
 * The one kind label an issue carries. Two of them is a map that would draw
 * differently depending on which label gh happened to list first, so it is
 * refused rather than resolved.
 */
function issueKind(named: string, labels: Set<string>): NodeKind {
  const kinds = [...labels].filter(label => label.startsWith(KIND_LABEL_PREFIX));
  if (kinds.length > 1) {
    throw new Error(
      `${named}: carries ${kinds.length} kind labels (${kinds.join(', ')}) – ` +
        `a node has exactly one kind, ${ALLOWED_KINDS_SENTENCE}`
    );
  }
  if (kinds.length === 0) {
    throw new Error(`${named}: no kind:<value> label – ${ALLOWED_KINDS_SENTENCE}`);
  }
  const value = kinds[0].slice(KIND_LABEL_PREFIX.length);
  if (!(NODE_KINDS as readonly string[]).includes(value)) {
    throw new Error(`${named}: kind label '${kinds[0]}' is not allowed – ${ALLOWED_KINDS_SENTENCE}`);
  }
  return value as NodeKind;
}

/**
 * The label a node draws, held to the same caps the files backend enforces. The
 * rule itself lives in nodes.ts, so a header that would be refused as a file is
 * refused as an issue in the same words.
 */
function issueLabel(named: string, header: Map<string, string>): string {
  const trimmed = (header.get('label') ?? '').trim();
  const problem = labelCapProblem(trimmed);
  if (problem) throw new Error(`${named}: label "${trimmed}" ${problem}`);
  return trimmed;
}

/** One issue as a node, or the reason it is not one. */
function nodeFromIssue(entry: unknown, at: number): DiagramNode {
  // An entry with no number has nothing to name it by, so it is named by where
  // it sits in the list gh emitted, counting from one.
  const where = `the issue at position ${at + 1}`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`${where} is ${describe(entry)}, not an issue object`);
  }
  const issue = entry as Record<string, unknown>;
  if (typeof issue.number !== 'number' || !Number.isFinite(issue.number)) {
    throw new Error(
      `${where} has no number – the number is the node's whole identity, and a ` +
        'node without one would draw as `undefined`'
    );
  }
  const named = `issue ${issue.number}`;
  const labels = labelsOf(named, issue.labels);
  const header = parseHeader(firstNonBlankLine(bodyOf(named, issue.body)));
  if (!header) {
    throw new Error(
      `${named}: the body does not open with the "map: ..." header line, ` +
        'which is where every edge and the node label live'
    );
  }
  const answers = header.get('answers');
  return {
    id: String(issue.number),
    title: textOf(issue.title),
    status: issueStatus(textOf(issue.state), textOf(issue.stateReason), labels),
    mode: labels.has('afk') ? 'afk' : 'hitl',
    kind: issueKind(named, labels),
    label: issueLabel(named, header),
    answers: answers ? bareId(answers) : undefined,
    blockedBy: (header.get('blocked-by') ?? '').split(',').map(bareId).filter(Boolean),
    pinned: labels.has('pinned'),
    url: typeof issue.url === 'string' ? issue.url : undefined,
  };
}

// Two issues sharing a number is one node overwriting another wherever the map
// is keyed by id, which is everywhere. The files backend refuses it on load and
// so does this.
function refuseDuplicateNumbers(nodes: DiagramNode[]): void {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      throw new Error(
        `issue ${node.id}: duplicate issue number – two issues in this list are ` +
          `both numbered ${node.id}`
      );
    }
    seen.add(node.id);
  }
}

function refuseUnknownBlockers(nodes: DiagramNode[]): void {
  const known = new Set(nodes.map(n => n.id));
  for (const node of nodes) {
    for (const blocker of node.blockedBy) {
      if (!known.has(blocker)) {
        throw new Error(
          `issue ${node.id}: blocked-by names ${blocker}, which is not in this map – ` +
            'the list is truncated or the header is stale'
        );
      }
    }
  }
}

// blocked-by must stay a DAG – a cycle would deadlock every node on it,
// silently, since the frontier only ever sees unresolved blockers. `updateNode`
// refuses one on the files backend; a hand-edited issue header can write one
// just as easily.
function refuseBlockedByCycles(nodes: DiagramNode[]): void {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const acyclic = new Set<string>();
  const walk = (id: string, trail: Set<string>): void => {
    if (acyclic.has(id)) return;
    if (trail.has(id)) {
      throw new Error(
        `issue ${id}: blocked-by cycle through issue ${id} – these nodes would ` +
          'block each other forever'
      );
    }
    trail.add(id);
    for (const blocker of byId.get(id)?.blockedBy ?? []) walk(blocker, trail);
    trail.delete(id);
    acyclic.add(id);
  };
  for (const node of nodes) walk(node.id, new Set());
}

/** Turns `gh issue list --json ...` output into the nodes the renderer draws. */
export function nodesFromIssues(json: string): DiagramNode[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`could not parse the issue list as JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error('the issue list must be a JSON array, as `gh issue list --json` emits it');
  }
  const nodes = (raw as unknown[]).map(nodeFromIssue);
  refuseDuplicateNumbers(nodes);
  refuseUnknownBlockers(nodes);
  refuseBlockedByCycles(nodes);
  return nodes;
}
