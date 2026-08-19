import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNode,
  deriveDepths,
  frontier,
  getNode,
  loadNodes,
  mapDir,
  updateNode,
} from './nodes.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spechub-nodes-'));
  mkdirSync(join(root, 'spechub'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('create', () => {
  it('writes the root with defaults and no parent', () => {
    const node = createNode(root, 'demo', { title: 'What does done look like?' });
    expect(node.id).toBe('001');
    expect(node.status).toBe('open');
    expect(node.mode).toBe('hitl');
    expect(node.answers).toBeUndefined();
    expect(node.file).toBe('001-what-does-done-look-like.md');
  });

  it('rejects a parent on the first node', () => {
    expect(() => createNode(root, 'demo', { title: 'A', answers: '001' })).toThrow(/root/);
  });

  it('rejects a second root', () => {
    createNode(root, 'demo', { title: 'Root' });
    expect(() => createNode(root, 'demo', { title: 'Orphan' })).toThrow(/needs --answers/);
  });

  it('rejects a missing parent or blocker', () => {
    createNode(root, 'demo', { title: 'Root' });
    expect(() => createNode(root, 'demo', { title: 'A', answers: '009' })).toThrow(/does not exist/);
    expect(() =>
      createNode(root, 'demo', { title: 'A', answers: '001', blockedBy: ['009'] })
    ).toThrow(/does not exist/);
  });

  it('allocates max plus one and pads ids', () => {
    createNode(root, 'demo', { title: 'Root' });
    createNode(root, 'demo', { title: 'A', answers: '1' });
    const c = createNode(root, 'demo', { title: 'B', answers: '002' });
    expect(c.id).toBe('003');
    expect(c.answers).toBe('002');
  });

  it('stores kind, pinned, blockers and body', () => {
    createNode(root, 'demo', { title: 'Root' });
    createNode(root, 'demo', { title: 'A', answers: '001' });
    const node = createNode(root, 'demo', {
      title: 'B',
      answers: '001',
      kind: 'grilling',
      pinned: true,
      blockedBy: ['002'],
      body: '## Question\n\nWhy?',
    });
    const reread = getNode(root, 'demo', '003');
    expect(reread.kind).toBe('grilling');
    expect(reread.pinned).toBe(true);
    expect(reread.blockedBy).toEqual(['002']);
    expect(reread.body).toContain('## Question');
    expect(reread.title).toBe('B');
    expect(node.file).toBe(reread.file);
  });
});

describe('read', () => {
  it('coerces an unquoted numeric answers field back to a padded id', () => {
    createNode(root, 'demo', { title: 'Root' });
    const dir = mapDir(root, 'demo');
    writeFileSync(
      join(dir, '002-hand-written.md'),
      '---\nstatus: open\nmode: afk\nanswers: 001\nblocked-by: []\n---\n\n# Hand written\n'
    );
    const node = getNode(root, 'demo', '002');
    expect(node.answers).toBe('001');
    expect(node.mode).toBe('afk');
  });

  it('rejects an unknown status', () => {
    const dir = mapDir(root, 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + '/001-bad.md', '---\nstatus: wip\nmode: hitl\n---\n\n# Bad\n');
    expect(() => loadNodes(root, 'demo')).toThrow(/status/);
  });

  it('throws on a missing node', () => {
    expect(() => getNode(root, 'demo', '001')).toThrow(/not found/);
  });
});

describe('update', () => {
  it('changes status and appends to the body', () => {
    createNode(root, 'demo', { title: 'Root', body: '## Question\n\nWhy?' });
    updateNode(root, 'demo', '001', { status: 'resolved', appendBody: '## Answer\n\nBecause.' });
    const node = getNode(root, 'demo', '001');
    expect(node.status).toBe('resolved');
    expect(node.body).toMatch(/## Question[\s\S]*## Answer/);
  });

  it('re-parents within the tree and normalizes the id', () => {
    createNode(root, 'demo', { title: 'Root' });
    createNode(root, 'demo', { title: 'A', answers: '001' });
    createNode(root, 'demo', { title: 'B', answers: '001' });
    const node = updateNode(root, 'demo', '3', { answers: '2' });
    expect(node.answers).toBe('002');
  });

  it('rejects a provenance cycle and self-reference', () => {
    createNode(root, 'demo', { title: 'Root' });
    createNode(root, 'demo', { title: 'A', answers: '001' });
    createNode(root, 'demo', { title: 'B', answers: '002' });
    expect(() => updateNode(root, 'demo', '002', { answers: '003' })).toThrow(/cycle/);
    expect(() => updateNode(root, 'demo', '002', { answers: '002' })).toThrow(/itself/);
  });

  it('refuses to give the root a parent', () => {
    createNode(root, 'demo', { title: 'Root' });
    createNode(root, 'demo', { title: 'A', answers: '001' });
    expect(() => updateNode(root, 'demo', '001', { answers: '002' })).toThrow(/root/);
  });

  it('replaces and clears blockers, rejecting self-blocking', () => {
    createNode(root, 'demo', { title: 'Root' });
    createNode(root, 'demo', { title: 'A', answers: '001' });
    createNode(root, 'demo', { title: 'B', answers: '001', blockedBy: ['002'] });
    expect(() => updateNode(root, 'demo', '003', { blockedBy: ['003'] })).toThrow(/itself/);
    updateNode(root, 'demo', '003', { blockedBy: [] });
    expect(getNode(root, 'demo', '003').blockedBy).toEqual([]);
  });

  it('clears kind and flips pinned', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'grilling', pinned: true });
    updateNode(root, 'demo', '001', { kind: null, pinned: false });
    const node = getNode(root, 'demo', '001');
    expect(node.kind).toBeUndefined();
    expect(node.pinned).toBe(false);
  });

  it('keeps the filename when the title changes', () => {
    createNode(root, 'demo', { title: 'Old title' });
    const node = updateNode(root, 'demo', '001', { title: 'New title' });
    expect(node.file).toBe('001-old-title.md');
    expect(getNode(root, 'demo', '001').title).toBe('New title');
  });
});

describe('list', () => {
  it('returns nodes sorted by id with an empty map returning empty', () => {
    expect(loadNodes(root, 'demo')).toEqual([]);
    createNode(root, 'demo', { title: 'Root' });
    createNode(root, 'demo', { title: 'A', answers: '001' });
    expect(loadNodes(root, 'demo').map(n => n.id)).toEqual(['001', '002']);
  });

  it('derives depth from the answers chain', () => {
    createNode(root, 'demo', { title: 'Root' });
    createNode(root, 'demo', { title: 'A', answers: '001' });
    createNode(root, 'demo', { title: 'B', answers: '002' });
    const depths = deriveDepths(loadNodes(root, 'demo'));
    expect(depths.get('001')).toBe(0);
    expect(depths.get('002')).toBe(1);
    expect(depths.get('003')).toBe(2);
  });

  it('names the node when a hand-edited parent is missing or cyclic', () => {
    const dir = mapDir(root, 'demo');
    mkdirSync(dir, { recursive: true });
    const frontmatter = (answers: string) =>
      `---\nstatus: open\nmode: hitl\nanswers: "${answers}"\nblocked-by: []\n---\n\n`;
    writeFileSync(join(dir, '001-a.md'), frontmatter('002') + '# A\n');
    writeFileSync(join(dir, '002-b.md'), frontmatter('001') + '# B\n');
    expect(() => deriveDepths(loadNodes(root, 'demo'))).toThrow(/cycle/);
    rmSync(join(dir, '002-b.md'));
    expect(() => deriveDepths(loadNodes(root, 'demo'))).toThrow(/does not exist/);
  });

  it('round-trips a serialized file byte-for-byte through parse and write', () => {
    createNode(root, 'demo', {
      title: 'Root',
      kind: 'grilling',
      pinned: true,
      body: 'Line one.\n\nLine two.',
    });
    const dir = mapDir(root, 'demo');
    const file = '001-root.md';
    const before = readFileSync(join(dir, file), 'utf-8');
    updateNode(root, 'demo', '001', {});
    const after = readFileSync(join(dir, file), 'utf-8');
    expect(after).toBe(before);
  });
});

describe('frontier', () => {
  it('returns open nodes with no unresolved blockers', () => {
    createNode(root, 'demo', { title: 'Root', status: 'resolved' });
    createNode(root, 'demo', { title: 'A', answers: '001' });
    createNode(root, 'demo', { title: 'B', answers: '001', blockedBy: ['002'] });
    createNode(root, 'demo', { title: 'C', answers: '001', status: 'fog' });
    const ready = frontier(loadNodes(root, 'demo'));
    expect(ready.map(n => n.id)).toEqual(['002']);
  });

  it('treats fog and claimed blockers as blocking, resolved and out-of-scope as settled', () => {
    createNode(root, 'demo', { title: 'Root', status: 'resolved' });
    createNode(root, 'demo', { title: 'Fog blocker', answers: '001', status: 'fog' });
    createNode(root, 'demo', { title: 'Claimed blocker', answers: '001', status: 'claimed' });
    createNode(root, 'demo', { title: 'Resolved blocker', answers: '001', status: 'resolved' });
    createNode(root, 'demo', { title: 'Descoped blocker', answers: '001', status: 'out-of-scope' });
    createNode(root, 'demo', { title: 'Behind fog', answers: '001', blockedBy: ['002'] });
    createNode(root, 'demo', { title: 'Behind claim', answers: '001', blockedBy: ['003'] });
    createNode(root, 'demo', { title: 'Behind settled', answers: '001', blockedBy: ['004', '005'] });
    const ready = frontier(loadNodes(root, 'demo'));
    expect(ready.map(n => n.id)).toEqual(['008']);
  });

  it('orders by shallowest depth, then id – a late shallow node jumps the queue', () => {
    createNode(root, 'demo', { title: 'Root', status: 'resolved' });
    createNode(root, 'demo', { title: 'Deep parent', answers: '001', status: 'resolved' });
    createNode(root, 'demo', { title: 'Deep open', answers: '002' });
    createNode(root, 'demo', { title: 'Late shallow', answers: '001' });
    createNode(root, 'demo', { title: 'Shallow sibling', answers: '001' });
    const ready = frontier(loadNodes(root, 'demo'));
    expect(ready.map(n => n.id)).toEqual(['004', '005', '003']);
  });
});
