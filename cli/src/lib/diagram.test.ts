import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode, loadNodes } from './nodes.js';
import type { CreateNodeInput, MapNode } from './nodes.js';
import { renderDiagram, stripDiagrams, DIAGRAM_START, DIAGRAM_END } from './diagram.js';
import type { DiagramNode } from './diagram.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spechub-diagram-'));
  mkdirSync(join(root, 'spechub'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Building input
// ---------------------------------------------------------------------------

/** Writes a map to disk and hands back its nodes, the files backend's input. */
function makeMap(map: string, specs: CreateNodeInput[]): MapNode[] {
  for (const spec of specs) createNode(root, map, spec);
  return loadNodes(root, map);
}

/**
 * A root and one child of it, as the github backend hands them over: ids raw
 * rather than zero-padded, and each node carrying the url of its issue.
 *
 * The renderer takes nodes, not issues, so these tests state what a node with a
 * url renders as. What a `gh issue list` payload parses into is the adapter's
 * own contract, stated in github-issues.test.ts.
 */
function githubNodes(): DiagramNode[] {
  return [
    {
      id: '101',
      title: 'Issue 101',
      kind: 'destination',
      status: 'open',
      mode: 'hitl',
      label: 'Ship it',
      blockedBy: [],
      pinned: false,
      url: 'https://github.com/acme/repo/issues/101',
    },
    {
      id: '102',
      title: 'Issue 102',
      kind: 'work',
      status: 'open',
      mode: 'hitl',
      label: 'Nodes in git?',
      answers: '101',
      blockedBy: [],
      pinned: false,
      url: 'https://github.com/acme/repo/issues/102',
    },
  ];
}

// ---------------------------------------------------------------------------
// Reading output
//
// Every helper works on the rendered text, so nothing here assumes a shape for
// the renderer's internals.
// ---------------------------------------------------------------------------

function fences(out: string): string[] {
  return [...out.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map(m => m[1]);
}

function mainFence(out: string): string {
  const found = fences(out);
  if (found.length < 1) throw new Error(`no mermaid fence in output:\n${out}`);
  return found[0];
}

function legendFence(out: string): string {
  const found = fences(out);
  if (found.length < 2) throw new Error(`no legend fence in output:\n${out}`);
  return found[1];
}

/**
 * The fence with its styling lines dropped, so a search for an id cannot land
 * inside a hex colour.
 */
function drawing(fence: string): string {
  return fence
    .split('\n')
    .filter(line => !/(?<![-\w])(fill|stroke)\s*:/i.test(line))
    .join('\n');
}

/** The ids a stretch of a line holds, with any quoted label text taken out first. */
function idsIn(part: string): string[] {
  return part.match(/[A-Za-z][\w-]*/g) ?? [];
}

/**
 * Every link the fence declares, in the order it declares them, which is the
 * order mermaid counts in when a `linkStyle` names a link by index. An invisible
 * `~~~` link is a link declaration like any other, so it takes an index too.
 *
 * One line can declare several links, as `a ~~~ b ~~~ c` does.
 */
function links(fence: string): { from: string; op: string; to: string }[] {
  const found: { from: string; op: string; to: string }[] = [];
  for (const raw of fence.split('\n')) {
    if (/^\s*(linkStyle|classDef|class|style|subgraph)\b/.test(raw)) continue;
    const parts = raw.replace(/"[^"]*"/g, '""').split(/(-\.->|-->|---|~~~)/);
    for (let i = 1; i < parts.length; i += 2) {
      const left = idsIn(parts[i - 1]);
      const right = idsIn(parts[i + 1] ?? '');
      if (left.length && right.length) {
        found.push({ from: left[left.length - 1], op: parts[i], to: right[0] });
      }
    }
  }
  return found;
}

/** True when the fence runs `arrow` with `from` on its left and `to` on its right. */
function hasEdge(fence: string, arrow: string, from: string, to: string): boolean {
  return links(fence).some(l => l.op === arrow && l.from.includes(from) && l.to.includes(to));
}

/** The indices, in declaration order, of the fence's dotted links. */
function dottedIndices(fence: string): number[] {
  return links(fence).flatMap((l, i) => (l.op === '-.->' ? [i] : []));
}

/** Every `linkStyle` line, as the link indices it names and the styling it applies. */
function linkStyles(fence: string): { indices: number[]; decl: string }[] {
  const styles: { indices: number[]; decl: string }[] = [];
  for (const line of fence.split('\n')) {
    const m = line.match(/^\s*linkStyle\s+([\d\s,]+?)\s+(\S.*?)\s*$/);
    if (!m) continue;
    styles.push({
      indices: m[1]
        .split(',')
        .map(s => Number(s.trim()))
        .filter(n => Number.isFinite(n)),
      decl: m[2],
    });
  }
  return styles;
}

/** The dash and gap lengths a styling declaration sets, in order. */
function dashLengths(decl: string): number[] {
  const m = decl.match(/stroke-dasharray\s*:\s*([^,;]+)/i);
  return m ? (m[1].match(/[\d.]+/g) ?? []).map(Number) : [];
}

function arrowLines(fence: string): string[] {
  return fence.split('\n').filter(line => line.includes('-->') || line.includes('-.->'));
}

function fillValues(fence: string): Set<string> {
  return new Set(
    [...fence.matchAll(/(?<![-\w])fill\s*:\s*([^,;\s'"]+)/gi)].map(m => m[1].toLowerCase())
  );
}

/** Every styling line that sets both a fill and a stroke, as a pair. */
function fillStrokePairs(fence: string): { fill: string; stroke: string }[] {
  const pairs: { fill: string; stroke: string }[] = [];
  for (const line of fence.split('\n')) {
    const fill = line.match(/(?<![-\w])fill\s*:\s*([^,;\s'"]+)/i);
    const stroke = line.match(/(?<![-\w])stroke\s*:\s*([^,;\s'"]+)/i);
    if (fill && stroke) pairs.push({ fill: fill[1].toLowerCase(), stroke: stroke[1].toLowerCase() });
  }
  return pairs;
}

/**
 * The legend's boxes, in draw order. A box is an id carrying a shape, wherever
 * the shape is written - on a line of its own or inline on a link.
 */
function legendBoxes(legend: string): string[] {
  const seen: string[] = [];
  for (const raw of legend.split('\n')) {
    if (/^\s*(linkStyle|classDef|class|style|subgraph|end|direction|flowchart|graph)\b/.test(raw)) {
      continue;
    }
    for (const m of raw.replace(/"[^"]*"/g, '""').matchAll(/([A-Za-z][\w-]*)(?=[[({])/g)) {
      if (!seen.includes(m[1])) seen.push(m[1]);
    }
  }
  return seen;
}

/**
 * The legend's rows, as groups of box ids in draw order. A row is what mermaid
 * ranks onto one line: the boxes some link holds together. Both link kinds count,
 * because an edge item's two boxes are one unit joined by their own visible
 * arrow, not by an invisible link.
 */
function legendChains(legend: string): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let cur = id;
    while (parent.get(cur) && parent.get(cur) !== cur) cur = parent.get(cur)!;
    parent.set(id, cur);
    return cur;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };
  const boxes = legendBoxes(legend);
  for (const box of boxes) parent.set(box, box);
  for (const link of links(legend)) {
    for (const id of [link.from, link.to]) if (!parent.has(id)) parent.set(id, id);
    union(link.from, link.to);
  }
  const groups = new Map<string, string[]>();
  for (const box of boxes) {
    const key = find(box);
    groups.set(key, [...(groups.get(key) ?? []), box]);
  }
  return [...groups.values()];
}

/**
 * The legend's link lines, as the position of each line in the fence and the
 * row it belongs to. A link line is any line carrying `~~~`, `-->` or `-.->`.
 * Its row is the one holding the boxes it joins, and a link line never spans
 * two rows, because a row is exactly what the links hold together.
 */
function legendLinkLines(legend: string): { at: number; row: number }[] {
  const rowOf = new Map<string, number>();
  legendChains(legend).forEach((row, at) => row.forEach(box => rowOf.set(box, at)));
  const found: { at: number; row: number }[] = [];
  legend.split('\n').forEach((raw, at) => {
    if (/^\s*(linkStyle|classDef|class|style|subgraph)\b/.test(raw)) return;
    if (!/~~~|-->|-\.->/.test(raw)) return;
    const rows = new Set(
      idsIn(raw.replace(/"[^"]*"/g, '""')).flatMap(id => {
        const row = rowOf.get(id);
        return row === undefined ? [] : [row];
      })
    );
    if (rows.size !== 1) throw new Error(`link line touches ${rows.size} rows: ${raw}`);
    found.push({ at, row: [...rows][0] });
  });
  return found;
}

/** Every classDef a fence declares, as its name and the declaration it carries. */
function classDefs(fence: string): Map<string, string> {
  const defs = new Map<string, string>();
  for (const line of fence.split('\n')) {
    const def = line.match(/^\s*classDef\s+(\S+)\s+(.+)$/);
    if (def) defs.set(def[1], def[2]);
  }
  return defs;
}

/** One comma-separated mermaid style declaration, as the properties it sets. */
function declProps(decl: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const part of decl.split(',')) {
    const at = part.indexOf(':');
    if (at > 0) {
      props[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim().toLowerCase();
    }
  }
  return props;
}

/** A style narrowed to its stroke properties, which are what draws a cue. */
function strokeProps(props: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith('stroke')));
}

/**
 * The style properties that reach one node. A node is bound to its styling by a
 * `class` line naming a classDef, and by nothing else - neither fence carries an
 * inline `:::name` or a `style` line - so this reads the one mechanism the
 * renderer emits rather than guessing at the three mermaid allows.
 */
function styleOf(fence: string, mermaidId: string): Record<string, string> {
  const defs = classDefs(fence);
  let decl = '';
  for (const line of fence.split('\n')) {
    const assigned = line.match(/^\s*class\s+([\w,\s-]+?)\s+(\S+)\s*$/);
    if (
      assigned &&
      assigned[1]
        .split(',')
        .map(s => s.trim())
        .includes(mermaidId)
    ) {
      decl = defs.get(assigned[2]) ?? '';
    }
  }
  return declProps(decl);
}

/**
 * The name of the class one node is bound to, or the empty string when no
 * `class` line names it. The name is the cue itself – `open`, `resolvedHitl`,
 * `openFront` – so a test can state which cue landed rather than unpicking the
 * stroke properties the cue draws.
 */
function classNameOf(fence: string, mermaidId: string): string {
  let name = '';
  for (const line of fence.split('\n')) {
    const assigned = line.match(/^\s*class\s+([\w,\s-]+?)\s+(\S+)\s*$/);
    if (
      assigned &&
      assigned[1]
        .split(',')
        .map(s => s.trim())
        .includes(mermaidId)
    ) {
      name = assigned[2];
    }
  }
  return name;
}

/** The first line of a node's label, which is the id, the kind and the status field. */
function labelHeadOf(fence: string, mermaidId: string): string {
  return labelTextOf(fence, mermaidId).split('\n')[0];
}

/**
 * The label text one node carries, with the markup the renderer wraps around it
 * taken back off: the `<br/>` between the label's parts becomes a newline, and
 * the anchor around the id goes. Whatever `<`, `>`, `&` or `"` is left came from
 * the label itself.
 */
function labelTextOf(fence: string, mermaidId: string): string {
  const line = fence.split('\n').find(l => new RegExp(`(^|\\s)${mermaidId}[[({]`).test(l));
  if (!line) throw new Error(`no line for ${mermaidId} in:\n${fence}`);
  const quoted = line.match(/"([\s\S]*)"/);
  if (!quoted) throw new Error(`no quoted label on: ${line}`);
  return quoted[1].replace(/<br\s*\/?>/g, '\n').replace(/<a href='[^']*'>|<\/a>/g, '');
}

/**
 * The invariant both dash tests share, in the main fence and in the legend: a
 * widened dash lands on every blocked-by link a fence draws, and on no other.
 */
function expectWidenedDashOnBlockedLinksOnly(fence: string): void {
  const dotted = dottedIndices(fence);
  expect(dotted.length).toBeGreaterThan(0);
  const widened = linkStyles(fence).filter(style => dashLengths(style.decl).length > 0);
  expect(widened.flatMap(style => style.indices).sort((a, b) => a - b)).toEqual(dotted);
  for (const style of widened) {
    for (const length of dashLengths(style.decl)) expect(length).toBeGreaterThanOrEqual(5);
  }
}

/**
 * A map exercising every visual channel at once: all five kinds, four statuses,
 * an unresolved hitl node, a frontier node, and both edge kinds.
 */
function richNodes(): MapNode[] {
  return makeMap('rich', [
    { title: 'Root', kind: 'destination', label: 'Ship it', mode: 'hitl' },
    { title: 'Foggy', kind: 'notes', label: 'Foggy', answers: '001', status: 'fog', mode: 'hitl' },
    {
      title: 'Claimed',
      kind: 'decision',
      label: 'Claimed',
      answers: '001',
      status: 'claimed',
      mode: 'hitl',
    },
    {
      title: 'Dropped',
      kind: 'research',
      label: 'Dropped',
      answers: '001',
      status: 'out-of-scope',
      mode: 'afk',
    },
    {
      title: 'Waiting',
      kind: 'work',
      label: 'Waiting',
      answers: '001',
      blockedBy: ['002'],
      mode: 'afk',
    },
    // The root carries no status of its own and never sits on the frontier, so
    // the frontier node this map needs has to be one of the others.
    { title: 'Ready', kind: 'work', label: 'Ready', answers: '001', mode: 'hitl' },
  ]);
}

/**
 * The map behind the legend the row rule is stated against: four shapes, two
 * fills, the frontier item and both edge items, which is eleven boxes. Every
 * node is afk, so no mode item joins them.
 */
function elevenBoxNodes(): MapNode[] {
  return makeMap('eleven', [
    { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
    { title: 'Ready', kind: 'work', label: 'Ready', answers: '001', mode: 'afk' },
    {
      title: 'Dropped',
      kind: 'decision',
      label: 'Dropped',
      answers: '001',
      status: 'out-of-scope',
      mode: 'afk',
    },
    {
      title: 'Waiting',
      kind: 'research',
      label: 'Waiting',
      answers: '001',
      blockedBy: ['002'],
      mode: 'afk',
    },
  ]);
}

/**
 * A map whose legend holds thirteen boxes: three shapes, three fills, both mode
 * items, the frontier item and both edge items. Thirteen is the smallest size
 * at which the fewest rows a legend could use, two, would put seven boxes in a
 * row, so it is where the six-box cap is the only thing holding a row down.
 */
function thirteenBoxNodes(): MapNode[] {
  return makeMap('thirteen', [
    { title: 'Root', kind: 'destination', label: 'Root', mode: 'hitl' },
    { title: 'Ready', kind: 'work', label: 'Ready', answers: '001', mode: 'afk' },
    {
      title: 'Dropped',
      kind: 'work',
      label: 'Dropped',
      answers: '001',
      status: 'out-of-scope',
      mode: 'afk',
    },
    {
      title: 'Waiting',
      kind: 'notes',
      label: 'Waiting',
      answers: '001',
      blockedBy: ['002'],
      mode: 'afk',
    },
    // The root is hitl too, but the root never carries a mode cue, so this is
    // the node that puts the two mode items in the legend.
    {
      title: 'Claimed',
      kind: 'work',
      label: 'Claimed',
      answers: '001',
      status: 'claimed',
      mode: 'hitl',
    },
  ]);
}

/** A map whose legend holds one shape and one fill, and no cue and no edge. */
function oneNode(): MapNode[] {
  return makeMap('one', [{ title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' }]);
}

/**
 * A root and one child of it, and deliberately nothing else: two kinds of the
 * five, one status of the four, both nodes afk, and no blocked-by edge. Two
 * legend tests below assert on what the legend leaves out, and those only mean
 * anything while the map stays exactly this shape.
 */
function rootAndChild(): MapNode[] {
  return makeMap('pair', [
    { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
    { title: 'Child', kind: 'work', label: 'Child', answers: '001', mode: 'afk' },
  ]);
}

// ---------------------------------------------------------------------------

describe('shape', () => {
  it.each([
    ['destination', (line: string) => line.includes('{{')],
    ['notes', (line: string) => line.includes('[[')],
    ['decision', (line: string) => line.includes('{') && !line.includes('{{')],
    ['research', (line: string) => line.includes('([')],
    [
      'work',
      (line: string) => line.includes('[') && !line.includes('[[') && !line.includes('(['),
    ],
  ] as const)('draws %s with its own shape', (kind, matches) => {
    const nodes = makeMap(kind, [
      { title: 'Only node', kind, label: 'Only node', mode: 'afk' },
    ]);
    const node = drawing(mainFence(renderDiagram(nodes)))
      .split('\n')
      .filter(line => line.includes('Only node'));
    expect(node).toHaveLength(1);
    expect(matches(node[0])).toBe(true);
  });
});

describe('label text', () => {
  it('carries the id, the kind, the status and the label field', () => {
    // The root's status word is replaced by a count of its subtree, so the
    // node stating this rule is one of the others.
    const main = mainFence(renderDiagram(rootAndChild()));
    expect(labelHeadOf(main, 'n002')).toBe('&num;002 work - open');
    expect(labelTextOf(main, 'n002')).toContain('Child');
  });

  it.each([
    ['angle brackets', 'Use <db> now', 'db'],
    ['an ampersand', 'Fish & chips', 'Fish'],
  ])('escapes %s, so the label reaches the reader intact', (_name, label, survives) => {
    // A mermaid label is rendered as HTML: a raw `<db>` is swallowed as a tag,
    // and a raw `</a>` closes the anchor the renderer opened around the id.
    const nodes = makeMap('demo', [{ title: 'Only node', kind: 'work', label, mode: 'afk' }]);
    const text = labelTextOf(mainFence(renderDiagram(nodes)), 'n001');
    expect(text).not.toMatch(/[<>]/);
    // Every ampersand left has to open an entity, or the escaping made one.
    expect(text).not.toMatch(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;)/);
    expect(text).toContain(survives);
  });

  it('escapes a quote once, on a node that sits on an edge', () => {
    // A quoted label only takes the fence down once its node sits on an edge,
    // which is where mermaid runs `btoa` over the node data. Escaping the
    // ampersand first is what keeps the entity from being escaped a second time.
    const nodes = makeMap('demo', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
      { title: 'Child', kind: 'work', label: 'Say "hi" now', answers: '001', mode: 'afk' },
    ]);
    const main = mainFence(renderDiagram(nodes));
    expect(hasEdge(main, '-->', '001', '002')).toBe(true);
    const text = labelTextOf(main, 'n002');
    expect(text).toContain('&quot;');
    expect(text).not.toContain('&amp;quot;');
    expect(text).not.toContain('"');
  });

  // Mermaid's `encodeEntities` rewrites anything matching `/#\w+;/` into a
  // sentinel built from codepoints above U+00FF, so a label holding `#39;`
  // reaches the reader as visible garbage. `&num;` renders back as a literal
  // hash, so every hash is escaped, unconditionally.
  it('escapes a hash that opens what mermaid reads as an entity', () => {
    const nodes = makeMap('demo', [
      { title: 'Only node', kind: 'work', label: 'Fix #39; now', mode: 'afk' },
    ]);
    const text = labelTextOf(mainFence(renderDiagram(nodes)), 'n001');
    expect(text).toContain('&num;39;');
    expect(text).not.toContain('#39;');
  });

  it('escapes a plain hash too, so one rule covers every hash', () => {
    const nodes = makeMap('demo', [
      { title: 'Only node', kind: 'work', label: 'Issue #193', mode: 'afk' },
    ]);
    const text = labelTextOf(mainFence(renderDiagram(nodes)), 'n001');
    expect(text).toContain('Issue &num;193');
    expect(text).not.toContain('#193');
  });

  it('escapes a literal &num; the user typed, since the ampersand goes first', () => {
    const nodes = makeMap('demo', [
      { title: 'Only node', kind: 'work', label: 'Types &num; here', mode: 'afk' },
    ]);
    const text = labelTextOf(mainFence(renderDiagram(nodes)), 'n001');
    expect(text).toContain('&amp;num;');
  });

  it('escapes the hash the anchor draws in front of the id', () => {
    // The id is part of the same label the escaping protects, so the hash the
    // anchor puts in front of it is escaped the same way - no raw hash reaches
    // a label from any source.
    const text = labelTextOf(mainFence(renderDiagram(githubNodes())), 'n102');
    expect(text).toContain('&num;102');
    expect(text).not.toContain('#102');
  });
});

describe('fill', () => {
  it('gives four statuses four distinct fills', () => {
    const fills = fillValues(mainFence(renderDiagram(richNodes())));
    expect(fills.size).toBeGreaterThanOrEqual(4);
  });
});

describe('mode', () => {
  it('draws an unresolved hitl node differently from the same node afk', () => {
    const hitl = makeMap('hitl', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
      { title: 'Child', kind: 'work', label: 'Child', answers: '001', mode: 'hitl' },
    ]);
    const afk = makeMap('afk', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
      { title: 'Child', kind: 'work', label: 'Child', answers: '001', mode: 'afk' },
    ]);
    expect(mainFence(renderDiagram(hitl))).not.toBe(mainFence(renderDiagram(afk)));
  });

  it('draws a resolved node the same whether it is hitl or afk', () => {
    const hitl = makeMap('hitl', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
      {
        title: 'Child',
        kind: 'work',
        label: 'Child',
        answers: '001',
        status: 'resolved',
        mode: 'hitl',
      },
    ]);
    const afk = makeMap('afk', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
      {
        title: 'Child',
        kind: 'work',
        label: 'Child',
        answers: '001',
        status: 'resolved',
        mode: 'afk',
      },
    ]);
    expect(mainFence(renderDiagram(hitl))).toBe(mainFence(renderDiagram(afk)));
  });
});

describe('frontier', () => {
  it('outlines the frontier node and hides every other stroke behind its own fill', () => {
    const pairs = fillStrokePairs(mainFence(renderDiagram(richNodes())));
    expect(pairs.some(p => p.stroke === p.fill)).toBe(true);
    expect(pairs.some(p => p.stroke !== p.fill)).toBe(true);
  });

  it.each([
    ['fog', false],
    ['open', true],
    ['claimed', false],
    ['resolved', false],
    ['out-of-scope', false],
  ] as const)('counts a %s node as a frontier node: %s', (status, onFrontier) => {
    const nodes = makeMap(status, [
      { title: 'Root', kind: 'destination', label: 'Root', status: 'resolved', mode: 'afk' },
      { title: 'Child', kind: 'work', label: 'Child', answers: '001', status, mode: 'afk' },
    ]);
    const legend = legendFence(renderDiagram(nodes));
    expect(legend.includes('frontier')).toBe(onFrontier);
  });

  it('counts a node unblocked only because its blocker resolved', () => {
    const blocked = makeMap('blocked', [
      { title: 'Root', kind: 'destination', label: 'Root', status: 'resolved', mode: 'afk' },
      { title: 'Blocker', kind: 'work', label: 'Blocker', answers: '001', status: 'fog', mode: 'afk' },
      {
        title: 'Waiting',
        kind: 'work',
        label: 'Waiting',
        answers: '001',
        blockedBy: ['002'],
        mode: 'afk',
      },
    ]);
    const cleared = makeMap('cleared', [
      { title: 'Root', kind: 'destination', label: 'Root', status: 'resolved', mode: 'afk' },
      {
        title: 'Blocker',
        kind: 'work',
        label: 'Blocker',
        answers: '001',
        status: 'resolved',
        mode: 'afk',
      },
      {
        title: 'Waiting',
        kind: 'work',
        label: 'Waiting',
        answers: '001',
        blockedBy: ['002'],
        mode: 'afk',
      },
    ]);
    expect(legendFence(renderDiagram(blocked))).not.toContain('frontier');
    expect(legendFence(renderDiagram(cleared))).toContain('frontier');
  });
});

describe('edges', () => {
  it('points the answers arrow from the node that surfaced the question to the question', () => {
    const nodes = rootAndChild();
    const main = mainFence(renderDiagram(nodes));
    expect(hasEdge(main, '-->', '001', '002')).toBe(true);
    expect(hasEdge(main, '-->', '002', '001')).toBe(false);
  });

  it('points the blocked-by arrow from the blocker to the node that waits', () => {
    const nodes = makeMap('demo', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
      { title: 'Blocker', kind: 'work', label: 'Blocker', answers: '001', mode: 'afk' },
      {
        title: 'Waiting',
        kind: 'work',
        label: 'Waiting',
        answers: '001',
        blockedBy: ['002'],
        mode: 'afk',
      },
    ]);
    const main = mainFence(renderDiagram(nodes));
    expect(hasEdge(main, '-.->', '002', '003')).toBe(true);
    expect(hasEdge(main, '-.->', '003', '002')).toBe(false);
  });

  it('widens the dash on every blocked-by edge, and on no other edge', () => {
    const main = mainFence(renderDiagram(richNodes()));
    // The main fence draws answers edges too, so the invariant is separating
    // the blocked-by edges out rather than styling everything it draws.
    expect(links(main).length).toBeGreaterThan(dottedIndices(main).length);
    expectWidenedDashOnBlockedLinksOnly(main);
  });
});

describe('collapse', () => {
  it('collapses a resolved subtree to one node', () => {
    const nodes = makeMap('demo', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
      { title: 'Done', kind: 'work', label: 'Done', answers: '001', status: 'resolved', mode: 'afk' },
      {
        title: 'Deeper',
        kind: 'work',
        label: 'Deeper',
        answers: '002',
        status: 'resolved',
        mode: 'afk',
      },
      {
        title: 'Deepest',
        kind: 'work',
        label: 'Deepest',
        answers: '003',
        status: 'resolved',
        mode: 'afk',
      },
    ]);
    const drawn = drawing(mainFence(renderDiagram(nodes)));
    expect(drawn).toContain('002');
    expect(drawn).not.toContain('003');
    expect(drawn).not.toContain('004');
    expect(drawn).not.toContain('Deepest');
  });

  it('carries a count of what the collapsed subtree holds', () => {
    const spec = (extra: number): CreateNodeInput[] => {
      const specs: CreateNodeInput[] = [
        { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
        {
          title: 'Done',
          kind: 'work',
          label: 'Done',
          answers: '001',
          status: 'resolved',
          mode: 'afk',
        },
      ];
      for (let i = 0; i < extra; i++) {
        specs.push({
          title: `Under ${i}`,
          kind: 'work',
          label: `Under ${i}`,
          answers: '002',
          status: 'resolved',
          mode: 'afk',
        });
      }
      return specs;
    };
    const small = mainFence(renderDiagram(makeMap('small', spec(1))));
    const big = mainFence(renderDiagram(makeMap('big', spec(4))));
    // Both collapse to the same node, so only the count it carries can differ.
    expect(drawing(small)).not.toContain('003');
    expect(drawing(big)).not.toContain('003');
    expect(small).not.toBe(big);
  });

  it('never collapses the root, even when the whole map is resolved', () => {
    const nodes = makeMap('demo', [
      {
        title: 'Root',
        kind: 'destination',
        label: 'Root',
        status: 'resolved',
        mode: 'afk',
      },
      { title: 'Done', kind: 'work', label: 'Done', answers: '001', status: 'resolved', mode: 'afk' },
    ]);
    expect(arrowLines(mainFence(renderDiagram(nodes))).length).toBeGreaterThan(0);
  });

  it('never collapses an out-of-scope node, nor a subtree holding one', () => {
    const nodes = makeMap('demo', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
      { title: 'Done', kind: 'work', label: 'Done', answers: '001', status: 'resolved', mode: 'afk' },
      {
        title: 'Dropped',
        kind: 'work',
        label: 'Dropped',
        answers: '002',
        status: 'out-of-scope',
        mode: 'afk',
      },
    ]);
    const drawn = drawing(mainFence(renderDiagram(nodes)));
    expect(drawn).toContain('002');
    expect(drawn).toContain('003');
    expect(drawn).toContain('Dropped');
  });
});

describe('scope', () => {
  it('draws only the node named by from and its descendants', () => {
    const nodes = makeMap('demo', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
      { title: 'Branch', kind: 'work', label: 'Branch', answers: '001', mode: 'afk' },
      { title: 'Under branch', kind: 'work', label: 'Under branch', answers: '002', mode: 'afk' },
      { title: 'Sibling', kind: 'work', label: 'Sibling', answers: '001', mode: 'afk' },
    ]);
    const drawn = drawing(mainFence(renderDiagram(nodes, { from: '002' })));
    expect(drawn).toContain('002');
    expect(drawn).toContain('003');
    expect(drawn).not.toContain('004');
    expect(drawn).not.toContain('Sibling');
    expect(drawn).not.toContain('Root');
  });

  it.each(['002', '2', '0002'])('finds the node named by from, written as %s', from => {
    // An id is written padded on the files backend and bare on github, and a
    // reader copying one out of either has to be able to hand it straight back.
    const nodes = makeMap('demo', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
      { title: 'Branch', kind: 'work', label: 'Branch', answers: '001', mode: 'afk' },
      { title: 'Under branch', kind: 'work', label: 'Under branch', answers: '002', mode: 'afk' },
      { title: 'Sibling', kind: 'work', label: 'Sibling', answers: '001', mode: 'afk' },
    ]);
    const drawn = drawing(mainFence(renderDiagram(nodes, { from })));
    expect(drawn).toContain('Branch');
    expect(drawn).toContain('Under branch');
    expect(drawn).not.toContain('Sibling');
  });

  it('names a blocker outside the drawn subtree in the label of the node it holds', () => {
    const nodes = makeMap('demo', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
      { title: 'Blocker', kind: 'work', label: 'Blocker', answers: '001', mode: 'afk' },
      { title: 'Branch', kind: 'work', label: 'Branch', answers: '001', mode: 'afk' },
      {
        title: 'Under branch',
        kind: 'work',
        label: 'Under branch',
        answers: '003',
        blockedBy: ['002'],
        mode: 'afk',
      },
    ]);
    const main = mainFence(renderDiagram(nodes, { from: '003' }));
    // The blocker is off the drawn subtree, so the only place its hold can show
    // is the label of the node waiting on it - the way a collapsed subtree's
    // count carries the nodes it hid.
    expect(drawing(main)).not.toContain('Blocker');
    expect(labelTextOf(main, 'n004')).toContain('002');
  });
});

describe('legend', () => {
  it('sits in a second fence below the main diagram, which holds no subgraph', () => {
    const out = renderDiagram(richNodes());
    expect(fences(out)).toHaveLength(2);
    expect(mainFence(out)).not.toContain('subgraph');
    expect(out.indexOf(fences(out)[0])).toBeLessThan(out.indexOf(fences(out)[1]));
  });

  it('draws the whole legend inside a subgraph titled Legend', () => {
    const legend = legendFence(renderDiagram(richNodes()));
    const lines = legend.split('\n');
    const opens = lines.filter(line => /^\s*subgraph\b/.test(line));
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatch(/\bLegend\b/);
    const open = lines.indexOf(opens[0]);
    const close = lines.findIndex((line, at) => at > open && /^\s*end\s*$/.test(line));
    expect(close).toBeGreaterThan(open);
    const inside = lines.slice(open + 1, close).join('\n');
    for (const box of legendBoxes(legend)) expect(legendBoxes(inside)).toContain(box);
  });

  it('chains its items left to right with invisible links', () => {
    const legend = legendFence(renderDiagram(richNodes()));
    expect(legend).toMatch(/(?:flowchart|graph)\s+LR/i);
    expect(legend).toContain('~~~');
  });

  it.each([
    ['one node', 2, 1, oneNode],
    ['four shapes, two fills, a frontier item and both edge items', 11, 2, elevenBoxNodes],
  ] as const)('draws the legend for %s, %i boxes, as %i rows', (_name, boxes, rows, nodes) => {
    const legend = legendFence(renderDiagram(nodes()));
    expect(legendBoxes(legend)).toHaveLength(boxes);
    expect(legendChains(legend)).toHaveLength(rows);
  });

  it('never draws more than three rows, however many boxes it holds', () => {
    const legend = legendFence(renderDiagram(richNodes()));
    expect(legendBoxes(legend).length).toBeGreaterThan(6);
    expect(legendChains(legend).length).toBeLessThanOrEqual(3);
  });

  it('spreads the boxes evenly over the rows it draws', () => {
    const rows = legendChains(legendFence(renderDiagram(richNodes()))).map(row => row.length);
    expect(rows.length).toBeGreaterThan(1);
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(1);
  });

  it.each([
    ['the rich legend', richNodes],
    ['the eleven-box legend', elevenBoxNodes],
  ] as const)('emits the link lines of %s a row at a time, in row order', (_name, nodes) => {
    const legend = legendFence(renderDiagram(nodes()));
    const rowCount = legendChains(legend).length;
    expect(rowCount).toBeGreaterThan(1);
    // Read down the fence, the row each link line belongs to never goes back up,
    // so every link line of one row sits above every link line of the next.
    const order = legendLinkLines(legend).map(line => line.row);
    expect(new Set(order).size).toBe(rowCount);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it.each([
    ['the rich legend', richNodes],
    ['a thirteen-box legend', thirteenBoxNodes],
  ] as const)('holds at most six boxes in a row, on %s', (_name, nodes) => {
    const legend = legendFence(renderDiagram(nodes()));
    // At thirteen boxes or more, laying the legend out in the fewest rows it
    // could use would put seven in a row, so only the cap keeps them to six.
    expect(legendBoxes(legend).length).toBeGreaterThanOrEqual(13);
    expect(Math.max(...legendChains(legend).map(row => row.length))).toBeLessThanOrEqual(6);
  });

  it.each([
    ['the rich legend', richNodes],
    ['the eleven-box legend', elevenBoxNodes],
  ] as const)('runs the chain of %s through every box in draw order', (_name, nodes) => {
    const legend = legendFence(renderDiagram(nodes()));
    const boxes = legendBoxes(legend);
    const rows = legendChains(legend);
    const rowOf = new Map<string, number>();
    rows.forEach((row, at) => row.forEach(box => rowOf.set(box, at)));
    // Each row is a run of consecutive boxes, so a break in the chain only ever
    // falls between one row and the next - never through an edge item.
    expect(rows.map(row => row.map(box => boxes.indexOf(box)))).toEqual(
      rows.map(row => {
        const first = boxes.indexOf(row[0]);
        return row.map((_box, at) => first + at);
      })
    );
    const linked = new Set(links(legend).map(l => `${l.from} ${l.to}`));
    const unlinked: string[] = [];
    for (let at = 1; at < boxes.length; at++) {
      const before = boxes[at - 1];
      const box = boxes[at];
      if (rowOf.get(before) !== rowOf.get(box)) continue;
      if (!linked.has(`${before} ${box}`)) unlinked.push(`${before} to ${box}`);
    }
    expect(unlinked).toEqual([]);
  });

  it('widens the dash on its own blocked-by edge, and on no other link', () => {
    const legend = legendFence(renderDiagram(richNodes()));
    // The legend draws one blocked-by edge, among invisible chain links and its
    // own answers edge, so the same invariant holds here as in the main fence.
    expect(dottedIndices(legend)).toHaveLength(1);
    expectWidenedDashOnBlockedLinksOnly(legend);
  });

  it.each([
    ['the frontier cue', rootAndChild, 'n002'],
    ['the hitl cue', richNodes, 'n002'],
  ] as const)('draws %s with the stroke the diagram draws it with', (_name, nodes, mermaidId) => {
    const out = renderDiagram(nodes());
    // A legend that restated a cue would go stale the moment the diagram's own
    // stroke changed, so the two are compared rather than either pinned.
    const drawn = strokeProps(styleOf(mainFence(out), mermaidId));
    expect(Object.keys(drawn).length).toBeGreaterThan(0);
    const shown = [...classDefs(legendFence(out)).values()].map(decl =>
      strokeProps(declProps(decl))
    );
    expect(shown).toContainEqual(drawn);
  });

  it('lists only the cues the diagram uses', () => {
    const legend = legendFence(renderDiagram(rootAndChild()));
    expect(legend).toContain('destination');
    expect(legend).toContain('work');
    expect(legend).not.toContain('research');
    expect(legend).not.toContain('notes');
    expect(legend).not.toContain('decision');
  });

  it('draws no mode item when no node is unresolved and hitl', () => {
    const legend = legendFence(renderDiagram(rootAndChild()));
    expect(legend).not.toContain('afk');
  });

  it('draws every cue rather than describing it in words', () => {
    const legend = legendFence(renderDiagram(richNodes()));
    for (const word of ['hexagon', 'rhombus', 'stadium', 'subroutine', 'dotted', 'dashed']) {
      expect(legend).not.toContain(word);
    }
  });

  it('glosses the two terms a reader may not hold', () => {
    const legend = legendFence(renderDiagram(richNodes()));
    expect(legend).toContain('afk (agent can work alone)');
    expect(legend).toContain('frontier (ready to work on)');
  });

  it('labels a legend edge on the edge, not in the boxes', () => {
    const compact = legendFence(renderDiagram(richNodes())).replace(/\s+/g, '');
    expect(compact).toMatch(/(?:-->|-\.->)\|[^|]+\||--[A-Za-z][^->]*-->/);
  });

  it('carries no hyperlink, even on the github input', () => {
    const legend = legendFence(renderDiagram(githubNodes()));
    expect(legend).not.toContain('<a ');
    expect(legend).not.toContain('href');
  });
});

describe('anchors', () => {
  it('wraps the id alone in an anchor on the github input', () => {
    const main = mainFence(renderDiagram(githubNodes()));
    const anchors = [...main.matchAll(/<a href='([^']*)'>([^<]*)<\/a>/g)];
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    const child = anchors.find(a => a[2].includes('102'));
    expect(child).toBeDefined();
    expect(child![1]).toBe('https://github.com/acme/repo/issues/102');
    // The hash in front of the id is escaped like every other hash a label
    // carries - see the label escaping tests above.
    expect(child![2]).toBe('&num;102');
    expect(child![2]).not.toContain('Nodes in git?');
  });

  it('quotes the anchor href with single quotes', () => {
    const main = mainFence(renderDiagram(githubNodes()));
    expect(main).toContain("href='");
    expect(main).not.toContain('href="');
  });

  it('leaves ids as plain text on the files input', () => {
    const main = mainFence(renderDiagram(rootAndChild()));
    expect(main).not.toContain('<a ');
    expect(main).not.toContain('href');
  });
});

describe('output', () => {
  it('wraps both fences in the replaceable marker comments', () => {
    const out = renderDiagram(richNodes());
    const start = out.indexOf('<!-- spechub:diagram -->');
    const end = out.indexOf('<!-- /spechub:diagram -->');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const [main, legend] = fences(out);
    expect(out.indexOf(main)).toBeGreaterThan(start);
    expect(out.indexOf(legend) + legend.length).toBeLessThan(end);
  });
});

describe('node id', () => {
  it('prefixes the mermaid id with n and the visible id with a hash, padded on files', () => {
    const main = mainFence(renderDiagram(rootAndChild()));
    expect(main).toContain('n001');
    expect(main).toContain('&num;001');
    expect(main).toContain('n002');
    expect(main).toContain('&num;002');
  });

  it('keeps the issue number raw on the github input, never zero-padded', () => {
    const main = mainFence(renderDiagram(githubNodes()));
    expect(main).toContain('n101');
    expect(main).toContain('&num;101');
    expect(drawing(main)).not.toContain('0101');
  });
});

describe('stroke', () => {
  it('outlines a frontier node in magenta at five pixels', () => {
    // The root never sits on the frontier, so the outlined node is the child.
    const style = styleOf(mainFence(renderDiagram(rootAndChild())), 'n002');
    expect(style['stroke']).toBe('#bf3989');
    expect(style['stroke-width']).toBe('5px');
    expect(style['stroke-dasharray']).toBeUndefined();
  });

  it('dashes an unresolved hitl node dark at two pixels when it is off the frontier', () => {
    const style = styleOf(mainFence(renderDiagram(richNodes())), 'n002');
    expect(style['stroke']).toBe('#1f2328');
    expect(style['stroke-width']).toBe('2px');
    expect(style['stroke-dasharray']).toBe('6 4');
  });

  it('gives a node that is neither the stroke of its own fill, so no border shows', () => {
    const style = styleOf(mainFence(renderDiagram(richNodes())), 'n005');
    expect(style['fill']).toBeDefined();
    expect(style['stroke']).toBe(style['fill']);
    expect(style['stroke-dasharray']).toBeUndefined();
  });

  it('keeps the mode dash on a node both on the frontier and unresolved hitl', () => {
    const style = styleOf(mainFence(renderDiagram(richNodes())), 'n006');
    expect(style['stroke']).toBe('#bf3989');
    expect(style['stroke-width']).toBe('5px');
    expect(style['stroke-dasharray']).toBe('6 4');
  });

  it.each(['resolved', 'out-of-scope'] as const)('draws no mode cue on a %s hitl node', status => {
    const main = mainFence(
      renderDiagram(
        makeMap(status, [
          { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
          { title: 'Settled', kind: 'work', label: 'Settled', answers: '001', status, mode: 'hitl' },
        ])
      )
    );
    expect(main).not.toContain('stroke-dasharray');
  });
});

// ---------------------------------------------------------------------------
// The root
//
// The root carries no status of its own. What it shows is derived from every
// other node in the map: the label counts them, the fill says whether any is
// still unresolved, and no cue ever lands on it.
// ---------------------------------------------------------------------------

/** A root of the given stored status, over one child of the given status. */
function rootOver(
  map: string,
  rootStatus: MapNode['status'],
  childStatus: MapNode['status'],
  rootMode: MapNode['mode'] = 'afk'
): MapNode[] {
  return makeMap(map, [
    { title: 'Root', kind: 'destination', label: 'Root', status: rootStatus, mode: rootMode },
    { title: 'Child', kind: 'work', label: 'Child', answers: '001', status: childStatus, mode: 'afk' },
  ]);
}

describe('root label', () => {
  it('counts the unresolved nodes below the root in place of a status word', () => {
    const nodes = makeMap('counted', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
      { title: 'Done', kind: 'work', label: 'Done', answers: '001', status: 'resolved', mode: 'afk' },
      {
        title: 'Dropped',
        kind: 'work',
        label: 'Dropped',
        answers: '001',
        status: 'out-of-scope',
        mode: 'afk',
      },
      { title: 'Ready', kind: 'work', label: 'Ready', answers: '001', mode: 'afk' },
      { title: 'Foggy', kind: 'work', label: 'Foggy', answers: '001', status: 'fog', mode: 'afk' },
      {
        title: 'Claimed',
        kind: 'work',
        label: 'Claimed',
        answers: '001',
        status: 'claimed',
        mode: 'afk',
      },
    ]);
    // Five nodes below the root, of which open, fog and claimed are unresolved.
    expect(labelHeadOf(mainFence(renderDiagram(nodes)), 'n001')).toBe(
      '&num;001 destination - 3 of 5 open'
    );
  });

  it('prints 0 of 0 open on a root with no other node', () => {
    expect(labelHeadOf(mainFence(renderDiagram(oneNode())), 'n001')).toBe(
      '&num;001 destination - 0 of 0 open'
    );
  });

  it('counts the nodes a collapsed subtree hides, not the boxes drawn', () => {
    const nodes = makeMap('hidden', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'afk' },
      { title: 'Done', kind: 'work', label: 'Done', answers: '001', status: 'resolved', mode: 'afk' },
      {
        title: 'Deeper',
        kind: 'work',
        label: 'Deeper',
        answers: '002',
        status: 'resolved',
        mode: 'afk',
      },
    ]);
    const main = mainFence(renderDiagram(nodes));
    expect(drawing(main)).not.toContain('003');
    expect(labelHeadOf(main, 'n001')).toBe('&num;001 destination - 0 of 2 open');
  });

  it.each(['open', 'fog', 'claimed', 'resolved', 'out-of-scope'] as const)(
    'ignores the status the root file stores: %s',
    status => {
      const main = mainFence(renderDiagram(rootOver(status, status, 'open')));
      const head = labelHeadOf(main, 'n001');
      expect(head).toBe('&num;001 destination - 1 of 1 open');
      expect(head).not.toMatch(/destination - (open|fog|claimed|resolved|out-of-scope)\b/);
    }
  );

  it('counts the subtree when from names the root itself', () => {
    const main = mainFence(renderDiagram(rootAndChild(), { from: '001' }));
    expect(labelHeadOf(main, 'n001')).toBe('&num;001 destination - 1 of 1 open');
  });

  it('keeps the status word on a non-root node that from names', () => {
    const main = mainFence(renderDiagram(rootAndChild(), { from: '002' }));
    expect(labelHeadOf(main, 'n002')).toBe('&num;002 work - open');
    expect(drawing(main)).not.toContain('001');
  });
});

describe('root fill', () => {
  it('fills the root as resolved when every other node is settled', () => {
    const main = mainFence(renderDiagram(rootOver('settled', 'open', 'resolved')));
    expect(styleOf(main, 'n001')['fill']).toBe('#dafbe1');
    expect(classNameOf(main, 'n001')).toBe('resolved');
  });

  it('fills the root as open when one other node is unresolved', () => {
    const main = mainFence(renderDiagram(rootOver('unsettled', 'resolved', 'open')));
    expect(styleOf(main, 'n001')['fill']).toBe('#ddf4ff');
    expect(classNameOf(main, 'n001')).toBe('open');
  });

  it.each([
    ['resolved', 'resolved', 'open'],
    ['fog', 'open', 'resolved'],
  ] as const)(
    'swatches the derived status in the legend when the child is %s',
    (childStatus, shown, hidden) => {
      // The legend lists the statuses the drawing uses, so the root's stored
      // status must not put a swatch there and its derived one must.
      const legend = legendFence(renderDiagram(rootOver('swatch', hidden, childStatus)));
      expect(legend).toContain(shown);
      expect(legend).not.toContain(hidden);
    }
  );
});

describe('root cues', () => {
  it('never outlines the root as a frontier node', () => {
    const main = mainFence(renderDiagram(rootOver('front', 'open', 'open')));
    const style = styleOf(main, 'n001');
    expect(classNameOf(main, 'n001')).toBe('open');
    expect(style['stroke']).toBe(style['fill']);
    expect(style['stroke-width']).toBeUndefined();
  });

  it('never dashes the root, even when it stores hitl and open', () => {
    const main = mainFence(renderDiagram(rootOver('dash', 'open', 'open', 'hitl')));
    const style = styleOf(main, 'n001');
    expect(classNameOf(main, 'n001')).toBe('open');
    expect(style['stroke-dasharray']).toBeUndefined();
  });

  it('draws no mode legend item when the root is the only hitl node', () => {
    const legend = legendFence(renderDiagram(rootOver('lone', 'open', 'open', 'hitl')));
    expect(legend).not.toContain('hitl');
    expect(legend).not.toContain('afk');
  });

  it('draws the mode legend item when an unresolved hitl node is not the root', () => {
    const nodes = makeMap('other', [
      { title: 'Root', kind: 'destination', label: 'Root', mode: 'hitl' },
      { title: 'Child', kind: 'work', label: 'Child', answers: '001', mode: 'hitl' },
    ]);
    expect(legendFence(renderDiagram(nodes))).toContain('hitl (a human must answer)');
  });
});

// ---------------------------------------------------------------------------
// stripDiagrams
//
// The unit layer under the `node read` and `node walk` tests in
// cli/src/commands/node.test.ts. Those state what the two commands print; these
// state what the function does to one piece of text, marker by marker.
// ---------------------------------------------------------------------------

/** One generated block, in the marker-wrapped shape renderDiagram writes. */
function block(content = 'flowchart TD\n  n001["x"]'): string {
  return [DIAGRAM_START, '```mermaid', content, '```', DIAGRAM_END].join('\n');
}

describe('stripDiagrams', () => {
  it('leaves text holding no marker exactly as it is', () => {
    const text = 'Intro.\n\nSome prose.\n\n```mermaid\ngraph TD\n  A --> B\n```\n';
    expect(stripDiagrams(text)).toBe(text);
  });

  it('returns empty text unchanged', () => {
    expect(stripDiagrams('')).toBe('');
  });

  it('removes one complete block', () => {
    expect(stripDiagrams(`Intro.\n\n${block()}\n\nOutro.\n`)).toBe('Intro.\n\nOutro.\n');
  });

  it('removes both blocks when the text holds two', () => {
    const text = `Intro.\n\n${block()}\n\nMiddle.\n\n${block()}\n\nOutro.\n`;
    expect(stripDiagrams(text)).toBe('Intro.\n\nMiddle.\n\nOutro.\n');
  });

  it('leaves the text alone when a start marker has no end marker after it', () => {
    const text = `Intro.\n\n${DIAGRAM_START}\n\`\`\`mermaid\nflowchart TD\n\`\`\`\n\nOutro.\n`;
    expect(stripDiagrams(text)).toBe(text);
  });

  it('leaves a line carrying both markers alone, because neither sits alone on it', () => {
    // `renderDiagram` never writes the two markers on one line, so a human who
    // does is writing prose about them.
    const text = ['Intro.', '', `${DIAGRAM_START} ${DIAGRAM_END}`, '', 'Outro.', ''].join('\n');
    expect(stripDiagrams(text)).toBe(text);
  });

  it('leaves a mentioned start marker and the lone end marker below it alone', () => {
    // No start marker sits alone on its line, so there is no block to close and
    // the end marker below belongs to nothing. Pairing the mention with it
    // would take both paragraphs in between.
    const text = [
      `We write it between ${DIAGRAM_START} and its closing twin.`,
      '',
      'KEEP THIS PARAGRAPH.',
      '',
      DIAGRAM_END,
      '',
      'AFTER.',
      '',
    ].join('\n');
    expect(stripDiagrams(text)).toBe(text);
  });

  it.each([
    ['a trailing space', `${DIAGRAM_START} `],
    ['four spaces of indent', `    ${DIAGRAM_START}`],
  ])('counts a start marker written with %s, since the line holds nothing else', (_name, start) => {
    const text = [
      'Intro.',
      '',
      start,
      '```mermaid',
      'flowchart TD',
      '```',
      DIAGRAM_END,
      '',
      'Outro.',
      '',
    ].join('\n');
    expect(stripDiagrams(text)).toBe('Intro.\n\nOutro.\n');
  });

  it.each([
    [
      'nothing after it',
      ['Intro.', '', `See ${DIAGRAM_START} above.`, ''],
      ['Intro.', '', `See ${DIAGRAM_START} above.`, ''],
    ],
    [
      'a lone end marker after it',
      ['Intro.', '', `See ${DIAGRAM_START} above.`, '', DIAGRAM_END, '', 'AFTER.', ''],
      ['Intro.', '', `See ${DIAGRAM_START} above.`, '', DIAGRAM_END, '', 'AFTER.', ''],
    ],
    [
      'a real block after it',
      ['Intro.', '', `See ${DIAGRAM_START} above.`, '', block(), '', 'AFTER.', ''],
      ['Intro.', '', `See ${DIAGRAM_START} above.`, '', 'AFTER.', ''],
    ],
  ] as const)('never opens a block on a line that mentions a marker, with %s', (_name, lines, want) => {
    expect(stripDiagrams(lines.join('\n'))).toBe(want.join('\n'));
  });

  it('leaves markers alone inside a fenced code block', () => {
    const text = [
      'Intro.',
      '',
      '```markdown',
      DIAGRAM_START,
      DIAGRAM_END,
      '```',
      '',
      'Outro.',
      '',
    ].join('\n');
    expect(stripDiagrams(text)).toBe(text);
  });

  it('leaves markers alone inside a four-backtick fence wrapping a three-backtick one', () => {
    const text = [
      'Intro documenting the markers.',
      '',
      '````markdown',
      DIAGRAM_START,
      '',
      '```mermaid',
      'flowchart TD',
      '```',
      '',
      DIAGRAM_END,
      '````',
      '',
      'Outro.',
      '',
    ].join('\n');
    expect(stripDiagrams(text)).toBe(text);
  });

  it('abandons a start marker that a later start marker outruns', () => {
    // The first marker sits in a sentence about the markers, so it opens
    // nothing. Pairing it with the end marker below would take both paragraphs
    // in between with it.
    const text = [
      `A generated block opens with ${DIAGRAM_START} on its own line.`,
      '',
      'PROSE THE HUMAN WROTE.',
      '',
      block(),
      '',
      'MORE PROSE AFTER.',
      '',
    ].join('\n');
    expect(stripDiagrams(text)).toBe(
      `A generated block opens with ${DIAGRAM_START} on its own line.\n\n` +
        'PROSE THE HUMAN WROTE.\n\nMORE PROSE AFTER.\n'
    );
  });

  it('pairs an end marker with the last start marker before it, so an earlier start was prose', () => {
    // Both start markers sit alone on their own line and outside any fence, so
    // the alone-on-its-line rule and the fence rule pass them both. Only the
    // pairing rule tells the stray marker above from the block below.
    const text = [
      'Intro.',
      '',
      DIAGRAM_START,
      '',
      'PROSE BETWEEN TWO STARTS.',
      '',
      block(),
      '',
      'Outro.',
      '',
    ].join('\n');
    // The abandoned marker line is prose like every other line the human left,
    // so it stays where they wrote it.
    expect(stripDiagrams(text)).toBe(
      ['Intro.', '', DIAGRAM_START, '', 'PROSE BETWEEN TWO STARTS.', '', 'Outro.', ''].join('\n')
    );
  });

  it('leaves exactly one blank line at the seam, however many surrounded the block', () => {
    expect(stripDiagrams(`Intro.\n\n\n${block()}\n\n\n\nOutro.\n`)).toBe('Intro.\n\nOutro.\n');
  });

  it('leaves no blank line above the text when the block opens it', () => {
    expect(stripDiagrams(`${block()}\n\nOutro.\n`)).toBe('Outro.\n');
  });

  it('leaves no blank line below the text when the block closes it', () => {
    expect(stripDiagrams(`Intro.\n\n${block()}\n`)).toBe('Intro.\n');
  });
});
