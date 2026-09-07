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
  walkTree,
} from './nodes.js';
import type { CreateNodeInput, UpdateNodeInput } from './nodes.js';

let root: string;

/** The closed set a kind must come from. Held here so the tests state it, rather than mirror it. */
const KINDS = ['destination', 'notes', 'decision', 'research', 'work'] as const;

/** Slips a deliberately invalid input past the compile-time type, so the runtime check is what the test exercises. */
function invalid<T>(input: Record<string, unknown>): T {
  return input as unknown as T;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spechub-nodes-'));
  mkdirSync(join(root, 'spechub'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('create', () => {
  it('writes the root with defaults and no parent', () => {
    const node = createNode(root, 'demo', {
      title: 'What does done look like?',
      kind: 'destination',
      label: 'Done state',
    });
    expect(node.id).toBe('001');
    expect(node.status).toBe('open');
    expect(node.mode).toBe('hitl');
    expect(node.answers).toBeUndefined();
    expect(node.file).toBe('001-what-does-done-look-like.md');
  });

  it('rejects a parent on the first node', () => {
    expect(() =>
      createNode(root, 'demo', { title: 'A', kind: 'notes', label: 'A', answers: '001' })
    ).toThrow(/root/);
  });

  it('rejects a second root', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root' });
    expect(() => createNode(root, 'demo', { title: 'Orphan', kind: 'notes', label: 'Orphan' })).toThrow(
      /needs --answers/
    );
  });

  it('rejects a missing parent or blocker', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root' });
    expect(() =>
      createNode(root, 'demo', { title: 'A', kind: 'notes', label: 'A', answers: '009' })
    ).toThrow(/does not exist/);
    expect(() =>
      createNode(root, 'demo', {
        title: 'A',
        kind: 'notes',
        label: 'A',
        answers: '001',
        blockedBy: ['009'],
      })
    ).toThrow(/does not exist/);
  });

  it('allocates max plus one and pads ids', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root' });
    createNode(root, 'demo', { title: 'A', kind: 'notes', label: 'A', answers: '1' });
    const c = createNode(root, 'demo', { title: 'B', kind: 'notes', label: 'B', answers: '002' });
    expect(c.id).toBe('003');
    expect(c.answers).toBe('002');
  });

  it('rejects empty and multiline titles', () => {
    expect(() => createNode(root, 'demo', { title: '   ', kind: 'notes', label: 'Blank' })).toThrow(
      /empty/
    );
    expect(() =>
      createNode(root, 'demo', { title: 'Line1\nLine2', kind: 'notes', label: 'Two lines' })
    ).toThrow(/single line/);
  });

  it.each([...KINDS])('round-trips the kind %s', kind => {
    createNode(root, 'demo', { title: 'Root', kind, label: 'Root node' });
    expect(getNode(root, 'demo', '001').kind).toBe(kind);
  });

  it('rejects a kind outside the five, naming the value and the allowed set', () => {
    const attempt = () =>
      createNode(
        root,
        'demo',
        invalid<CreateNodeInput>({ title: 'Root', kind: 'grilling', label: 'Root node' })
      );
    expect(attempt).toThrow('grilling');
    for (const kind of KINDS) expect(attempt).toThrow(kind);
  });

  it('rejects a node with no kind', () => {
    expect(() =>
      createNode(root, 'demo', invalid<CreateNodeInput>({ title: 'Root', label: 'Root node' }))
    ).toThrow(/kind/i);
  });

  it('round-trips a label unchanged', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Token refresh flow' });
    expect(getNode(root, 'demo', '001').label).toBe('Token refresh flow');
  });

  it('rejects a node with no label', () => {
    expect(() =>
      createNode(root, 'demo', invalid<CreateNodeInput>({ title: 'Root', kind: 'notes' }))
    ).toThrow(/label/i);
  });

  it('accepts a label of exactly four words', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'notes', label: 'One two three four' });
    expect(getNode(root, 'demo', '001').label).toBe('One two three four');
  });

  it('rejects a label of more than four words, naming the cap and the label', () => {
    const attempt = () =>
      createNode(root, 'demo', { title: 'Root', kind: 'notes', label: 'One two three four five' });
    expect(attempt).toThrow('One two three four five');
    expect(attempt).toThrow('4');
  });

  it('accepts a label of exactly thirty characters', () => {
    const label = 'A'.repeat(30);
    createNode(root, 'demo', { title: 'Root', kind: 'notes', label });
    expect(getNode(root, 'demo', '001').label).toBe(label);
  });

  it('rejects a label longer than thirty characters, naming the cap and the label', () => {
    const label = 'A'.repeat(31);
    const attempt = () => createNode(root, 'demo', { title: 'Root', kind: 'notes', label });
    expect(attempt).toThrow(label);
    expect(attempt).toThrow('30');
  });

  it('trims the label and does not count the trimmed whitespace as words', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'notes', label: '  One two three four  ' });
    expect(getNode(root, 'demo', '001').label).toBe('One two three four');
  });

  it.each(['Auth: token flow', 'Say "yes" now'])('round-trips the label %s', label => {
    createNode(root, 'demo', { title: 'Root', kind: 'notes', label });
    expect(getNode(root, 'demo', '001').label).toBe(label);
  });

  it('rejects a label containing a newline, naming the label', () => {
    const attempt = () =>
      createNode(root, 'demo', { title: 'Root', kind: 'notes', label: 'Two\nlines' });
    expect(attempt).toThrow('single line');
    expect(attempt).toThrow(/Two.*lines/s);
  });

  it('stores kind, pinned, blockers and body', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root' });
    createNode(root, 'demo', { title: 'A', kind: 'notes', label: 'A', answers: '001' });
    const node = createNode(root, 'demo', {
      title: 'B',
      answers: '001',
      kind: 'decision',
      label: 'B node',
      pinned: true,
      blockedBy: ['002'],
      body: '## Question\n\nWhy?',
    });
    const reread = getNode(root, 'demo', '003');
    expect(reread.kind).toBe('decision');
    expect(reread.pinned).toBe(true);
    expect(reread.blockedBy).toEqual(['002']);
    expect(reread.body).toContain('## Question');
    expect(reread.title).toBe('B');
    expect(node.file).toBe(reread.file);
  });
});

describe('read', () => {
  it('coerces an unquoted numeric answers field back to a padded id', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root' });
    const dir = mapDir(root, 'demo');
    writeFileSync(
      join(dir, '002-hand-written.md'),
      '---\nstatus: open\nmode: afk\nkind: notes\nlabel: "Hand written"\nanswers: 001\nblocked-by: []\n---\n\n# Hand written\n'
    );
    const node = getNode(root, 'demo', '002');
    expect(node.answers).toBe('001');
    expect(node.mode).toBe('afk');
  });

  it('rejects an unknown status', () => {
    const dir = mapDir(root, 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      dir + '/001-bad.md',
      '---\nstatus: wip\nmode: hitl\nkind: notes\nlabel: "Bad"\n---\n\n# Bad\n'
    );
    expect(() => loadNodes(root, 'demo')).toThrow(/status/);
  });

  it('rejects an unknown kind in a stored file, naming the file and the value', () => {
    const dir = mapDir(root, 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '001-bad-kind.md'),
      '---\nstatus: open\nmode: hitl\nkind: grilling\nlabel: "Bad kind"\nblocked-by: []\n---\n\n# Bad kind\n'
    );
    const attempt = () => loadNodes(root, 'demo');
    expect(attempt).toThrow('grilling');
    expect(attempt).toThrow('001-bad-kind.md');
  });

  it.each([
    ['kind', '---\nstatus: open\nmode: hitl\nlabel: "No kind"\nblocked-by: []\n---\n\n# No kind\n'],
    ['label', '---\nstatus: open\nmode: hitl\nkind: notes\nblocked-by: []\n---\n\n# No label\n'],
  ])('rejects a stored file with no %s', (field, contents) => {
    const dir = mapDir(root, 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '001-missing.md'), contents);
    expect(() => loadNodes(root, 'demo')).toThrow(new RegExp(field, 'i'));
  });

  it('throws on a missing node', () => {
    expect(() => getNode(root, 'demo', '001')).toThrow(/not found/);
  });

  it('rejects duplicate ids across files, naming both', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root' });
    const dir = mapDir(root, 'demo');
    writeFileSync(
      join(dir, '001-imposter.md'),
      '---\nstatus: open\nmode: hitl\nkind: notes\nlabel: "Imposter"\nblocked-by: []\n---\n\n# Imposter\n'
    );
    expect(() => loadNodes(root, 'demo')).toThrow(/duplicate node id 001.*001-imposter/);
  });

  it('requires the title to be the first line after the frontmatter', () => {
    const dir = mapDir(root, 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '001-bad.md'),
      '---\nstatus: open\nmode: hitl\nkind: notes\nlabel: "Bad"\nblocked-by: []\n---\n\nprose above\n\n# Real title\n'
    );
    expect(() => loadNodes(root, 'demo')).toThrow(/first line after the frontmatter/);
  });

  it('keeps a # line inside the body as body, not title', () => {
    createNode(root, 'demo', {
      title: 'Root',
      kind: 'destination',
      label: 'Root',
      body: '```sh\n# a comment\necho hi\n```',
    });
    const node = getNode(root, 'demo', '001');
    expect(node.title).toBe('Root');
    expect(node.body).toContain('# a comment');
    expect(node.body).toContain('```');
  });

  it('parses CRLF files', () => {
    const dir = mapDir(root, 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '001-crlf.md'),
      '---\r\nstatus: open\r\nmode: hitl\r\nkind: notes\r\nlabel: "CRLF node"\r\nblocked-by: []\r\n---\r\n\r\n# CRLF node\r\n'
    );
    expect(getNode(root, 'demo', '001').title).toBe('CRLF node');
  });

  it('preserves leading indentation in the body', () => {
    createNode(root, 'demo', {
      title: 'Root',
      kind: 'destination',
      label: 'Root',
      body: '    indented first line\nplain',
    });
    updateNode(root, 'demo', '001', { status: 'resolved' });
    expect(getNode(root, 'demo', '001').body).toBe('    indented first line\nplain');
  });
});

describe('update', () => {
  it('changes status and appends to the body', () => {
    createNode(root, 'demo', {
      title: 'Root',
      kind: 'destination',
      label: 'Root',
      body: '## Question\n\nWhy?',
    });
    updateNode(root, 'demo', '001', { status: 'resolved', appendBody: '## Answer\n\nBecause.' });
    const node = getNode(root, 'demo', '001');
    expect(node.status).toBe('resolved');
    expect(node.body).toMatch(/## Question[\s\S]*## Answer/);
  });

  it('re-parents within the tree and normalizes the id', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root' });
    createNode(root, 'demo', { title: 'A', kind: 'notes', label: 'A', answers: '001' });
    createNode(root, 'demo', { title: 'B', kind: 'notes', label: 'B', answers: '001' });
    const node = updateNode(root, 'demo', '3', { answers: '2' });
    expect(node.answers).toBe('002');
  });

  it('rejects a provenance cycle and self-reference', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root' });
    createNode(root, 'demo', { title: 'A', kind: 'notes', label: 'A', answers: '001' });
    createNode(root, 'demo', { title: 'B', kind: 'notes', label: 'B', answers: '002' });
    expect(() => updateNode(root, 'demo', '002', { answers: '003' })).toThrow(/cycle/);
    expect(() => updateNode(root, 'demo', '002', { answers: '002' })).toThrow(/itself/);
  });

  it('refuses to give the root a parent', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root' });
    createNode(root, 'demo', { title: 'A', kind: 'notes', label: 'A', answers: '001' });
    expect(() => updateNode(root, 'demo', '001', { answers: '002' })).toThrow(/root/);
  });

  it('rejects a blocked-by cycle', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root' });
    createNode(root, 'demo', { title: 'A', kind: 'notes', label: 'A', answers: '001' });
    createNode(root, 'demo', {
      title: 'B',
      kind: 'notes',
      label: 'B',
      answers: '001',
      blockedBy: ['002'],
    });
    expect(() => updateNode(root, 'demo', '002', { blockedBy: ['003'] })).toThrow(/cycle/);
  });

  it('replaces and clears blockers, rejecting self-blocking', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root' });
    createNode(root, 'demo', { title: 'A', kind: 'notes', label: 'A', answers: '001' });
    createNode(root, 'demo', {
      title: 'B',
      kind: 'notes',
      label: 'B',
      answers: '001',
      blockedBy: ['002'],
    });
    expect(() => updateNode(root, 'demo', '003', { blockedBy: ['003'] })).toThrow(/itself/);
    updateNode(root, 'demo', '003', { blockedBy: [] });
    expect(getNode(root, 'demo', '003').blockedBy).toEqual([]);
  });

  it('moves kind to another of the five and rejects anything else', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'notes', label: 'Root node' });
    updateNode(root, 'demo', '001', { kind: 'decision' });
    expect(getNode(root, 'demo', '001').kind).toBe('decision');
    expect(() =>
      updateNode(root, 'demo', '001', invalid<UpdateNodeInput>({ kind: 'grilling' }))
    ).toThrow('grilling');
  });

  it('leaves the file untouched when a kind is rejected', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'notes', label: 'Root node' });
    const file = join(mapDir(root, 'demo'), '001-root.md');
    const before = readFileSync(file, 'utf-8');
    expect(() =>
      updateNode(root, 'demo', '001', invalid<UpdateNodeInput>({ kind: 'grilling' }))
    ).toThrow();
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('never lets kind become absent', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'notes', label: 'Root node' });
    expect(() =>
      updateNode(root, 'demo', '001', invalid<UpdateNodeInput>({ kind: null }))
    ).toThrow(/kind/i);
    expect(getNode(root, 'demo', '001').kind).toBe('notes');
  });

  it('changes the label', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'notes', label: 'Old label' });
    updateNode(root, 'demo', '001', { label: 'New label' });
    expect(getNode(root, 'demo', '001').label).toBe('New label');
  });

  it('applies both label caps on update', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'notes', label: 'Old label' });
    expect(() => updateNode(root, 'demo', '001', { label: 'One two three four five' })).toThrow(
      'One two three four five'
    );
    expect(() => updateNode(root, 'demo', '001', { label: 'A'.repeat(31) })).toThrow('30');
    expect(getNode(root, 'demo', '001').label).toBe('Old label');
  });

  it('flips pinned', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root', pinned: true });
    updateNode(root, 'demo', '001', { pinned: false });
    expect(getNode(root, 'demo', '001').pinned).toBe(false);
  });

  it('keeps the filename when the title changes', () => {
    createNode(root, 'demo', { title: 'Old title', kind: 'destination', label: 'Old title' });
    const node = updateNode(root, 'demo', '001', { title: 'New title' });
    expect(node.file).toBe('001-old-title.md');
    expect(getNode(root, 'demo', '001').title).toBe('New title');
  });
});

describe('list', () => {
  it('returns nodes sorted by id with an empty map returning empty', () => {
    expect(loadNodes(root, 'demo')).toEqual([]);
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root' });
    createNode(root, 'demo', { title: 'A', kind: 'notes', label: 'A', answers: '001' });
    expect(loadNodes(root, 'demo').map(n => n.id)).toEqual(['001', '002']);
  });

  it('derives depth from the answers chain', () => {
    createNode(root, 'demo', { title: 'Root', kind: 'destination', label: 'Root' });
    createNode(root, 'demo', { title: 'A', kind: 'notes', label: 'A', answers: '001' });
    createNode(root, 'demo', { title: 'B', kind: 'notes', label: 'B', answers: '002' });
    const depths = deriveDepths(loadNodes(root, 'demo'));
    expect(depths.get('001')).toBe(0);
    expect(depths.get('002')).toBe(1);
    expect(depths.get('003')).toBe(2);
  });

  it('names the node when a hand-edited parent is missing or cyclic', () => {
    const dir = mapDir(root, 'demo');
    mkdirSync(dir, { recursive: true });
    const frontmatter = (answers: string) =>
      `---\nstatus: open\nmode: hitl\nkind: notes\nlabel: "Node"\nanswers: "${answers}"\nblocked-by: []\n---\n\n`;
    writeFileSync(join(dir, '001-a.md'), frontmatter('002') + '# A\n');
    writeFileSync(join(dir, '002-b.md'), frontmatter('001') + '# B\n');
    expect(() => deriveDepths(loadNodes(root, 'demo'))).toThrow(/cycle/);
    rmSync(join(dir, '002-b.md'));
    expect(() => deriveDepths(loadNodes(root, 'demo'))).toThrow(/does not exist/);
  });

  it('round-trips a serialized file byte-for-byte through parse and write', () => {
    createNode(root, 'demo', {
      title: 'Root',
      kind: 'destination',
      label: 'Root node',
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

describe('walk', () => {
  it('emits preorder with children in id order, regardless of mode or status', () => {
    createNode(root, 'demo', {
      title: 'Root',
      kind: 'destination',
      label: 'Root',
      status: 'resolved',
    });
    createNode(root, 'demo', {
      title: 'A',
      kind: 'notes',
      label: 'A',
      answers: '001',
      status: 'resolved',
    });
    createNode(root, 'demo', {
      title: 'B',
      kind: 'notes',
      label: 'B',
      answers: '001',
      mode: 'afk',
      status: 'fog',
    });
    createNode(root, 'demo', {
      title: 'A1',
      kind: 'work',
      label: 'A1',
      answers: '002',
      status: 'out-of-scope',
    });
    const walk = walkTree(loadNodes(root, 'demo'));
    expect(walk.map(e => e.node.id)).toEqual(['001', '002', '004', '003']);
    expect(walk.map(e => e.depth)).toEqual([0, 1, 2, 1]);
  });

  it('returns empty for an empty map and rejects two roots', () => {
    expect(walkTree([])).toEqual([]);
    const dir = mapDir(root, 'demo');
    mkdirSync(dir, { recursive: true });
    const rootFile =
      '---\nstatus: open\nmode: hitl\nkind: notes\nlabel: "Node"\nblocked-by: []\n---\n\n';
    writeFileSync(join(dir, '001-a.md'), rootFile + '# A\n');
    writeFileSync(join(dir, '002-b.md'), rootFile + '# B\n');
    expect(() => walkTree(loadNodes(root, 'demo'))).toThrow(/2 roots/);
  });
});

describe('frontier', () => {
  it('returns open nodes with no unresolved blockers', () => {
    createNode(root, 'demo', {
      title: 'Root',
      kind: 'destination',
      label: 'Root',
      status: 'resolved',
    });
    createNode(root, 'demo', { title: 'A', kind: 'notes', label: 'A', answers: '001' });
    createNode(root, 'demo', {
      title: 'B',
      kind: 'notes',
      label: 'B',
      answers: '001',
      blockedBy: ['002'],
    });
    createNode(root, 'demo', {
      title: 'C',
      kind: 'notes',
      label: 'C',
      answers: '001',
      status: 'fog',
    });
    const ready = frontier(loadNodes(root, 'demo'));
    expect(ready.map(n => n.id)).toEqual(['002']);
  });

  it('treats fog and claimed blockers as blocking, resolved and out-of-scope as settled', () => {
    createNode(root, 'demo', {
      title: 'Root',
      kind: 'destination',
      label: 'Root',
      status: 'resolved',
    });
    createNode(root, 'demo', {
      title: 'Fog blocker',
      kind: 'notes',
      label: 'Fog blocker',
      answers: '001',
      status: 'fog',
    });
    createNode(root, 'demo', {
      title: 'Claimed blocker',
      kind: 'notes',
      label: 'Claimed blocker',
      answers: '001',
      status: 'claimed',
    });
    createNode(root, 'demo', {
      title: 'Resolved blocker',
      kind: 'notes',
      label: 'Resolved blocker',
      answers: '001',
      status: 'resolved',
    });
    createNode(root, 'demo', {
      title: 'Descoped blocker',
      kind: 'notes',
      label: 'Descoped blocker',
      answers: '001',
      status: 'out-of-scope',
    });
    createNode(root, 'demo', {
      title: 'Behind fog',
      kind: 'work',
      label: 'Behind fog',
      answers: '001',
      blockedBy: ['002'],
    });
    createNode(root, 'demo', {
      title: 'Behind claim',
      kind: 'work',
      label: 'Behind claim',
      answers: '001',
      blockedBy: ['003'],
    });
    createNode(root, 'demo', {
      title: 'Behind settled',
      kind: 'work',
      label: 'Behind settled',
      answers: '001',
      blockedBy: ['004', '005'],
    });
    const ready = frontier(loadNodes(root, 'demo'));
    expect(ready.map(n => n.id)).toEqual(['008']);
  });

  it('orders ids numerically past 999', () => {
    const dir = mapDir(root, 'demo');
    mkdirSync(dir, { recursive: true });
    const file = (answers?: string) =>
      `---\nstatus: open\nmode: hitl\nkind: notes\nlabel: "Node"\n${answers ? `answers: "${answers}"\n` : ''}blocked-by: []\n---\n\n# N\n`;
    writeFileSync(join(dir, '001-root.md'), file().replace('status: open', 'status: resolved'));
    writeFileSync(join(dir, '999-a.md'), file('001'));
    writeFileSync(join(dir, '1000-b.md'), file('001'));
    expect(frontier(loadNodes(root, 'demo')).map(n => n.id)).toEqual(['999', '1000']);
  });

  it('orders by shallowest depth, then id – a late shallow node jumps the queue', () => {
    createNode(root, 'demo', {
      title: 'Root',
      kind: 'destination',
      label: 'Root',
      status: 'resolved',
    });
    createNode(root, 'demo', {
      title: 'Deep parent',
      kind: 'notes',
      label: 'Deep parent',
      answers: '001',
      status: 'resolved',
    });
    createNode(root, 'demo', {
      title: 'Deep open',
      kind: 'work',
      label: 'Deep open',
      answers: '002',
    });
    createNode(root, 'demo', {
      title: 'Late shallow',
      kind: 'work',
      label: 'Late shallow',
      answers: '001',
    });
    createNode(root, 'demo', {
      title: 'Shallow sibling',
      kind: 'work',
      label: 'Shallow sibling',
      answers: '001',
    });
    const ready = frontier(loadNodes(root, 'demo'));
    expect(ready.map(n => n.id)).toEqual(['004', '005', '003']);
  });

  // The root carries no status of its own – its state is derived from its
  // subtree – so nobody works it and it never sits on the frontier, whatever
  // the file happens to store.
  it.each(['open', 'fog', 'claimed', 'resolved'] as const)(
    'never returns the root, whatever status it stores: %s',
    status => {
      createNode(root, 'demo', {
        title: 'Root',
        kind: 'destination',
        label: 'Root',
        status,
      });
      createNode(root, 'demo', { title: 'A', kind: 'work', label: 'A', answers: '001' });
      const ready = frontier(loadNodes(root, 'demo'));
      expect(ready.map(n => n.id)).toEqual(['002']);
    }
  );

  it('leaves every other node in place when the root is open rather than resolved', () => {
    const specs = (rootStatus: 'open' | 'resolved'): CreateNodeInput[] => [
      { title: 'Root', kind: 'destination', label: 'Root', status: rootStatus },
      { title: 'Deep parent', kind: 'notes', label: 'Deep parent', answers: '001', status: 'resolved' },
      { title: 'Deep open', kind: 'work', label: 'Deep open', answers: '002' },
      { title: 'Late shallow', kind: 'work', label: 'Late shallow', answers: '001' },
      { title: 'Blocked', kind: 'work', label: 'Blocked', answers: '001', blockedBy: ['003'] },
    ];
    for (const spec of specs('resolved')) createNode(root, 'settled', spec);
    for (const spec of specs('open')) createNode(root, 'unsettled', spec);
    const settled = frontier(loadNodes(root, 'settled')).map(n => n.id);
    const unsettled = frontier(loadNodes(root, 'unsettled')).map(n => n.id);
    expect(settled).toEqual(['004', '003']);
    expect(unsettled).toEqual(settled);
  });
});
