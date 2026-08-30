// Node #199: `spechub node read` and `spechub node walk` strip marker-bounded
// generated blocks from their human-readable output by default, and a new
// `--visuals` flag on each command puts the blocks back. `--json` always
// keeps the blocks, on both commands, whatever `--visuals` says.
//
// These tests spawn the built CLI, the same way config.test.ts does, and
// write real node markdown files into a real temporary SpecHub project. No
// mocks – see cli/src/lib/diagram.test.ts and cli/src/lib/github-issues.test.ts
// for the house style this follows.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIAGRAM_START, DIAGRAM_END } from '../lib/diagram.js';
import { NODE_KINDS } from '../lib/nodes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(__dirname, '..', '..', 'bin', 'spechub.js');

function runCli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: 'utf-8',
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    // Bounded so a hung child can never hang the test run.
    timeout: 10_000,
  });
}

/**
 * Runs `<producer> | spechub <args>` through a real shell.
 *
 * A pipe stdin only behaves like the real thing when a real producer is on the
 * other end of it, so these tests build one rather than handing the CLI a
 * string. The shell's own exit status is the CLI's, because the CLI closes the
 * pipeline.
 */
function runPiped(
  producer: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
) {
  const quoted = [process.execPath, CLI_BIN, ...args].map(a => JSON.stringify(a)).join(' ');
  return spawnSync('/bin/sh', ['-c', `${producer} | ${quoted}`], {
    encoding: 'utf-8',
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    // Longer than runCli's, because every producer here is deliberately slow.
    timeout: 20_000,
  });
}

// A colour code, as a pty writes it: escape, `[`, the numbers, `m`.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Runs the CLI under a real pseudo-terminal, so `process.stdin.isTTY` is true.
 *
 * `script` gives the child a pty, writes the session to /dev/null, echoes it to
 * its own stdout and exits with the child's status. Faking the flag on a mock
 * would test the mock; only a pty tests the check the code actually makes.
 */
function runTty(args: string[], opts: { cwd?: string } = {}): { status: number | null; text: string } {
  const quoted = [process.execPath, CLI_BIN, ...args].map(a => JSON.stringify(a)).join(' ');
  const result = spawnSync('script', ['-qec', quoted, '/dev/null'], {
    encoding: 'utf-8',
    cwd: opts.cwd,
    env: { ...process.env },
    timeout: 10_000,
  });
  // A terminal turns colour back on and ends every line with a carriage
  // return, and neither is part of what the message says.
  return {
    status: result.status,
    text: result.stdout.replace(ANSI, '').replace(/\r/g, ''),
  };
}

/** Writes a producer script into the project and hands back the shell word running it. */
function writeProducer(name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, source);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}`;
}

/**
 * A producer that writes `text` in ten pieces, one every 100ms, so it takes
 * about a second to finish and never goes quiet for more than 100ms.
 *
 * `writeSync` rather than `process.stdout.write`, because a pipe write through
 * the stream is asynchronous and the last piece would race the exit.
 */
function streamingProducer(name: string, text: string): string {
  return writeProducer(
    name,
    [
      `const { writeSync } = require('node:fs');`,
      `const payload = ${JSON.stringify(text)};`,
      `const size = Math.ceil(payload.length / 10);`,
      `let at = 0;`,
      `const timer = setInterval(() => {`,
      `  writeSync(1, payload.slice(at, at + size));`,
      `  at += size;`,
      `  if (at >= payload.length) clearInterval(timer);`,
      `}, 100);`,
    ].join('\n')
  );
}

/** A producer that holds the pipe open for three seconds and never writes a byte. */
function silentProducer(name: string): string {
  return writeProducer(name, `setTimeout(() => {}, 3000);\n`);
}

/** One `gh issue list --json ...` entry, in the shape nodesFromIssues reads. */
function issue(number: number, header: string, labels: string[]): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    body: `${header}\n\nSome prose.`,
    state: 'OPEN',
    stateReason: '',
    labels: labels.map(name => ({ name })),
    url: `https://github.com/acme/repo/issues/${number}`,
  };
}

/** A root and one child, as `gh issue list --json ...` emits them. */
function issuesJson(): string {
  return JSON.stringify([
    issue(101, 'map: demo · root: this · label: Ship it', [
      'map:demo',
      'kind:destination',
      'root-node',
    ]),
    issue(102, 'map: demo · root: #101 · answers: #101 · label: Nodes in git?', [
      'map:demo',
      'kind:work',
    ]),
  ]);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack: string, needle: string): number {
  return (haystack.match(new RegExp(escapeRegExp(needle), 'g')) ?? []).length;
}

/** A temp SpecHub project root: a directory holding spechub/project.yaml. */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'spechub-node-project-'));
  mkdirSync(join(root, 'spechub'), { recursive: true });
  writeFileSync(join(root, 'spechub', 'project.yaml'), '# test project\n');
  return root;
}

interface NodeFixture {
  id: string;
  title: string;
  body: string;
  answers?: string;
  pinned?: boolean;
}

/** Writes one node file, in the exact frontmatter+title+body shape nodes.ts reads. */
function writeNodeFile(root: string, map: string, fixture: NodeFixture): void {
  const dir = join(root, 'spechub', 'maps', map);
  mkdirSync(dir, { recursive: true });
  const frontmatter = ['status: open', 'mode: hitl', 'kind: work', `label: ${JSON.stringify(fixture.title)}`];
  if (fixture.answers) frontmatter.push(`answers: "${fixture.answers}"`);
  frontmatter.push('blocked-by: []');
  if (fixture.pinned) frontmatter.push('pinned: true');
  const content = `---\n${frontmatter.join('\n')}\n---\n\n# ${fixture.title}\n\n${fixture.body}\n`;
  const slug = fixture.title.toLowerCase().replace(/\s+/g, '-');
  writeFileSync(join(dir, `${fixture.id}-${slug}.md`), content);
}

/** One generated block, in the exact marker-wrapped shape renderDiagram writes. */
function diagramBlock(content = 'flowchart TD\n  n001["x"]'): string {
  return `${DIAGRAM_START}\n\`\`\`mermaid\n${content}\n\`\`\`\n${DIAGRAM_END}`;
}

/** The shape `--json` prints for one node, on both `node read` and `node walk`. */
interface NodeJson {
  id: string;
  body: string;
}

let root: string;

beforeEach(() => {
  root = makeProject();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// node read
// ---------------------------------------------------------------------------

describe('node read', () => {
  it('strips the generated block by default', () => {
    writeNodeFile(root, 'm', {
      id: '001',
      title: 'Read Strip',
      body: `Intro paragraph.\n\n${diagramBlock()}\n\nOutro paragraph.`,
    });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(DIAGRAM_START);
    expect(result.stdout).not.toContain(DIAGRAM_END);
    expect(result.stdout).not.toContain('```mermaid');
    expect(result.stdout).toContain('Intro paragraph.\n\nOutro paragraph.');
  });

  it('keeps the generated block intact with --visuals', () => {
    const body = `Intro paragraph.\n\n${diagramBlock()}\n\nOutro paragraph.`;
    writeNodeFile(root, 'm', { id: '001', title: 'Read Visuals', body });
    const result = runCli(['node', 'read', '001', '--map', 'm', '--visuals'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(body);
  });

  it('--json keeps the block intact without --visuals', () => {
    const body = `Intro paragraph.\n\n${diagramBlock()}\n\nOutro paragraph.`;
    writeNodeFile(root, 'm', { id: '001', title: 'Read Json', body });
    const result = runCli(['node', 'read', '001', '--map', 'm', '--json'], { cwd: root });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as NodeJson;
    expect(parsed.body).toContain(DIAGRAM_START);
    expect(parsed.body).toContain(DIAGRAM_END);
  });

  it('--json keeps the block intact with --visuals too', () => {
    const body = `Intro paragraph.\n\n${diagramBlock()}\n\nOutro paragraph.`;
    writeNodeFile(root, 'm', { id: '001', title: 'Read Json Visuals', body });
    const result = runCli(['node', 'read', '001', '--map', 'm', '--json', '--visuals'], { cwd: root });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as NodeJson;
    expect(parsed.body).toContain(DIAGRAM_START);
    expect(parsed.body).toContain(DIAGRAM_END);
  });

  it('removes both blocks when a body has two generated blocks', () => {
    const body =
      `Intro.\n\n${diagramBlock('flowchart TD\n  n001')}\n\n` +
      `Middle.\n\n${diagramBlock('flowchart TD\n  n002')}\n\nOutro.`;
    writeNodeFile(root, 'm', { id: '001', title: 'Two Blocks', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(DIAGRAM_START);
    expect(result.stdout).not.toContain(DIAGRAM_END);
    expect(result.stdout).toContain('Intro.\n\nMiddle.\n\nOutro.');
    expect(result.stdout).not.toMatch(/\n{3,}/);
  });

  it('leaves the body completely unchanged when a start marker has no matching end marker', () => {
    const body =
      `Intro.\n\n${DIAGRAM_START}\n\`\`\`mermaid\nflowchart TD\n\`\`\`\n\nOutro (no end marker).`;
    writeNodeFile(root, 'm', { id: '001', title: 'Unmatched Marker', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(body);
  });

  it('leaves a mermaid fence outside the markers untouched', () => {
    const body = `Intro.\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n\nOutro.`;
    writeNodeFile(root, 'm', { id: '001', title: 'Hand Drawn', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(body);
  });

  it('leaves no leading blank line when the block opens the body', () => {
    const body = `${diagramBlock()}\n\nOutro paragraph.`;
    writeNodeFile(root, 'm', { id: '001', title: 'Block At Start', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# Block At Start\n\nOutro paragraph.');
    expect(result.stdout).not.toMatch(/\n{3,}/);
  });

  it('leaves no trailing blank line when the block closes the body', () => {
    const body = `Intro paragraph.\n\n${diagramBlock()}`;
    writeNodeFile(root, 'm', { id: '001', title: 'Block At End', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    // The file's own trailing newline plus console.log's own is exactly two
    // – a third would mean a blank line survived before end of output.
    expect(result.stdout).toMatch(/Intro paragraph\.\n\n$/);
  });

  it('leaves a line carrying both markers alone, because neither sits alone on it', () => {
    // `renderDiagram` never writes the two markers on one line, so a human who
    // does is writing prose about them. No start marker sits alone on its own
    // line here, so nothing in this body is a block.
    const body = [
      `${DIAGRAM_START} ${DIAGRAM_END}`,
      '',
      'Prose that must survive.',
      '',
      DIAGRAM_END,
      '',
      'More prose.',
    ].join('\n');
    writeNodeFile(root, 'm', { id: '001', title: 'Same Line Markers', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(body);
  });

  it('leaves a mentioned start marker and the lone end marker below it alone', () => {
    // No start marker sits alone on its line, so the end marker below belongs
    // to nothing. Pairing the mention with it would take both paragraphs in
    // between.
    const body = [
      `We write it between ${DIAGRAM_START} and its closing twin.`,
      '',
      'KEEP THIS PARAGRAPH.',
      '',
      DIAGRAM_END,
      '',
      'AFTER.',
    ].join('\n');
    writeNodeFile(root, 'm', { id: '001', title: 'Lone End Marker', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(body);
  });

  it.each([
    ['a trailing space', `${DIAGRAM_START} `],
    ['four spaces of indent', `    ${DIAGRAM_START}`],
  ])('strips a block whose start marker is written with %s', (_name, start) => {
    const body = [
      'Intro.',
      '',
      start,
      '```mermaid',
      'flowchart TD',
      '```',
      DIAGRAM_END,
      '',
      'Outro.',
    ].join('\n');
    writeNodeFile(root, 'm', { id: '001', title: 'Padded Marker', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(DIAGRAM_START);
    expect(result.stdout).not.toContain(DIAGRAM_END);
    expect(result.stdout).not.toContain('```mermaid');
    expect(result.stdout).toContain('Intro.\n\nOutro.');
  });

  it.each([
    [
      'nothing after it',
      ['Intro.', '', `See ${DIAGRAM_START} above.`],
      ['Intro.', '', `See ${DIAGRAM_START} above.`],
    ],
    [
      'a lone end marker after it',
      ['Intro.', '', `See ${DIAGRAM_START} above.`, '', DIAGRAM_END, '', 'AFTER.'],
      ['Intro.', '', `See ${DIAGRAM_START} above.`, '', DIAGRAM_END, '', 'AFTER.'],
    ],
    [
      'a real block after it',
      ['Intro.', '', `See ${DIAGRAM_START} above.`, '', diagramBlock(), '', 'AFTER.'],
      ['Intro.', '', `See ${DIAGRAM_START} above.`, '', 'AFTER.'],
    ],
  ] as const)('never opens a block on a line that mentions a marker, with %s', (_name, lines, want) => {
    // The mention is prose whatever follows it, so it reaches the reader whole
    // and the prose on either side of it comes through with it.
    writeNodeFile(root, 'm', { id: '001', title: 'Mentioned Marker', body: lines.join('\n') });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(want.join('\n'));
    expect(result.stdout).not.toContain('```mermaid');
  });

  it('leaves markers alone when they sit inside a fenced code block', () => {
    // This body is documentation ABOUT the markers, not a generated block –
    // the marker lines and the mermaid fence they wrap sit inside a fence of
    // their own, and none of it is a real block to strip.
    const body = [
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
    ].join('\n');
    writeNodeFile(root, 'm', { id: '001', title: 'Markers In Fence', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(body);
  });

  it('collapses blank lines only around the removed block, never inside an unrelated fence', () => {
    const pythonFence = [
      '```python',
      'first_statement()',
      '',
      '',
      '',
      'second_statement()',
      '```',
    ].join('\n');
    const body = [
      diagramBlock(),
      '',
      'Some prose after the diagram.',
      '',
      pythonFence,
    ].join('\n');
    writeNodeFile(root, 'm', { id: '001', title: 'Blank Lines In Fence', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(DIAGRAM_START);
    expect(result.stdout).not.toContain(DIAGRAM_END);
    // The three blank lines belong to the python fence, not to the diagram
    // block's own boundary – a global cleanup would flatten them to one.
    expect(result.stdout).toContain(pythonFence);
  });

  it('keeps prose that mentions a start marker, and strips the real block below it', () => {
    // The first marker sits in a sentence about the markers, so it opens
    // nothing. Pairing it with the end marker below would take both paragraphs
    // in between with it.
    const body = [
      `A generated block opens with ${DIAGRAM_START} on its own line.`,
      '',
      'PROSE THE HUMAN WROTE.',
      '',
      diagramBlock(),
      '',
      'MORE PROSE AFTER.',
    ].join('\n');
    writeNodeFile(root, 'm', { id: '001', title: 'Stray Marker', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `A generated block opens with ${DIAGRAM_START} on its own line.\n\n` +
        'PROSE THE HUMAN WROTE.\n\nMORE PROSE AFTER.'
    );
    expect(result.stdout).not.toContain(DIAGRAM_END);
    expect(result.stdout).not.toContain('```mermaid');
  });

  it('carries past two mentioned start markers to the real block below them', () => {
    const body = [
      `First mention of ${DIAGRAM_START} in prose.`,
      '',
      `Second mention of ${DIAGRAM_START} in prose.`,
      '',
      diagramBlock(),
      '',
      'Tail prose.',
    ].join('\n');
    writeNodeFile(root, 'm', { id: '001', title: 'Two Stray Markers', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `First mention of ${DIAGRAM_START} in prose.\n\n` +
        `Second mention of ${DIAGRAM_START} in prose.\n\nTail prose.`
    );
    expect(result.stdout).not.toContain(DIAGRAM_END);
    expect(result.stdout).not.toContain('```mermaid');
  });

  it('pairs an end marker with the last start marker before it, so an earlier start was prose', () => {
    // Both start markers sit alone on their own line and outside any fence, so
    // the alone-on-its-line rule and the fence rule pass them both. Only the
    // pairing rule tells the stray marker above from the block below.
    const body = [
      'Intro.',
      '',
      DIAGRAM_START,
      '',
      'PROSE BETWEEN TWO STARTS.',
      '',
      diagramBlock(),
      '',
      'Outro.',
    ].join('\n');
    writeNodeFile(root, 'm', { id: '001', title: 'Two Starts', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    // The abandoned marker line is prose like every other line the human left,
    // so it stays where they wrote it.
    expect(result.stdout).toContain(
      ['Intro.', '', DIAGRAM_START, '', 'PROSE BETWEEN TWO STARTS.', '', 'Outro.'].join('\n')
    );
    expect(result.stdout).not.toContain(DIAGRAM_END);
    expect(result.stdout).not.toContain('```mermaid');
  });

  it('strips the last real block even when a mentioned marker follows it', () => {
    // The trailing mention shares its line with other words, so it opens
    // nothing and leaves nothing unterminated. The real block above it is a
    // complete block, and it goes.
    const mention = `A trailing mention of ${DIAGRAM_START} with no end marker after it.`;
    const body = ['Intro.', '', diagramBlock(), '', mention].join('\n');
    writeNodeFile(root, 'm', { id: '001', title: 'Trailing Stray Marker', body });
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Intro.\n\n${mention}`);
    expect(result.stdout).not.toContain(DIAGRAM_END);
    expect(result.stdout).not.toContain('```mermaid');
  });
});

// ---------------------------------------------------------------------------
// node walk
// ---------------------------------------------------------------------------

describe('node walk', () => {
  function makeWalkMap(): void {
    writeNodeFile(root, 'w', {
      id: '001',
      title: 'Root',
      body: `Root intro.\n\n${diagramBlock()}\n\nRoot outro.`,
    });
    writeNodeFile(root, 'w', {
      id: '002',
      title: 'Child',
      answers: '001',
      body: `Child intro.\n\n${diagramBlock()}\n\nChild outro.`,
    });
  }

  it('strips generated blocks from every emitted body by default', () => {
    makeWalkMap();
    const result = runCli(['node', 'walk', '--map', 'w'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(DIAGRAM_START);
    expect(result.stdout).not.toContain(DIAGRAM_END);
    expect(result.stdout).toContain('Root intro.\n\nRoot outro.');
  });

  it('keeps generated blocks intact with --visuals', () => {
    makeWalkMap();
    const result = runCli(['node', 'walk', '--map', 'w', '--visuals'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(DIAGRAM_START);
    expect(result.stdout).toContain(DIAGRAM_END);
    expect(result.stdout).toContain('Root intro.');
  });

  it('--json keeps bodies intact without --visuals', () => {
    makeWalkMap();
    const result = runCli(['node', 'walk', '--map', 'w', '--json'], { cwd: root });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as NodeJson[];
    const rootEntry = parsed.find(n => n.id === '001')!;
    expect(rootEntry.body).toContain(DIAGRAM_START);
    expect(rootEntry.body).toContain(DIAGRAM_END);
  });

  it('--json keeps bodies intact with --visuals too', () => {
    makeWalkMap();
    const result = runCli(['node', 'walk', '--map', 'w', '--json', '--visuals'], { cwd: root });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as NodeJson[];
    const rootEntry = parsed.find(n => n.id === '001')!;
    expect(rootEntry.body).toContain(DIAGRAM_START);
    expect(rootEntry.body).toContain(DIAGRAM_END);
  });

  it('--full strips generated blocks from every body, including non-root nodes', () => {
    makeWalkMap();
    const result = runCli(['node', 'walk', '--map', 'w', '--full'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(DIAGRAM_START);
    expect(result.stdout).not.toContain(DIAGRAM_END);
    expect(result.stdout).toContain('Root intro.\n\nRoot outro.');
    expect(result.stdout).toContain('Child intro.\n\nChild outro.');
  });

  it('--full --visuals keeps generated blocks intact on every body', () => {
    makeWalkMap();
    const result = runCli(['node', 'walk', '--map', 'w', '--full', '--visuals'], { cwd: root });
    expect(result.status).toBe(0);
    // One block survives on the root's body and one on the child's.
    expect(countOccurrences(result.stdout, DIAGRAM_START)).toBe(2);
    expect(countOccurrences(result.stdout, DIAGRAM_END)).toBe(2);
  });

  it('keeps prose that mentions a start marker, and strips the real block below it', () => {
    writeNodeFile(root, 'w', {
      id: '001',
      title: 'Stray Marker Root',
      body: [
        `A generated block opens with ${DIAGRAM_START} on its own line.`,
        '',
        'PROSE THE HUMAN WROTE.',
        '',
        diagramBlock(),
        '',
        'MORE PROSE AFTER.',
      ].join('\n'),
    });
    const result = runCli(['node', 'walk', '--map', 'w'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `A generated block opens with ${DIAGRAM_START} on its own line.\n\n` +
        'PROSE THE HUMAN WROTE.\n\nMORE PROSE AFTER.'
    );
    expect(result.stdout).not.toContain(DIAGRAM_END);
    expect(result.stdout).not.toContain('```mermaid');
  });
});

// ---------------------------------------------------------------------------
// node kinds
//
// The five kinds are a closed set a shell loop has to iterate - the github
// tracker creates one `kind:<value>` label per kind at materialisation. The set
// and its order are the contract that loop consumes, so both are pinned here.
// ---------------------------------------------------------------------------

/** The five kinds, in the order NODE_KINDS declares them. */
const KINDS = ['destination', 'notes', 'decision', 'research', 'work'];

describe('node kinds', () => {
  it('prints the five kinds, one per line, in declaration order', () => {
    const result = runCli(['node', 'kinds'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toEqual(KINDS);
  });

  it('prints the same five kinds the code declares', () => {
    // A sixth kind added to NODE_KINDS has to reach the shell loop, and this is
    // what says so before the loop silently keeps creating five labels.
    expect([...NODE_KINDS]).toEqual(KINDS);
  });

  it('prints nothing but the kinds - no colour and no prose', () => {
    const result = runCli(['node', 'kinds'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('\u001b');
    expect(result.stdout).toBe(`${KINDS.join('\n')}\n`);
  });

  it('--json prints them as a JSON array of strings', () => {
    const result = runCli(['node', 'kinds', '--json'], { cwd: root });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as string[];
    expect(parsed).toEqual(KINDS);
  });

  it('needs no --map, on either form', () => {
    for (const args of [
      ['node', 'kinds'],
      ['node', 'kinds', '--json'],
    ]) {
      const result = runCli(args, { cwd: root });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('--map');
    }
  });
});

// ---------------------------------------------------------------------------
// Enum rejections
//
// `Invalid value "<raw>" for <key>. Allowed values: <a, b, c>` is the one
// sentence the project already gives for a bad enum value, composed by
// invalidEnumValue in global-config.ts. Every flag holding an enum owes the
// user that sentence, so a user who learns to read one reads them all.
// ---------------------------------------------------------------------------

const STATUS_SENTENCE =
  'Invalid value "bogus" for --status. Allowed values: fog, open, claimed, resolved, out-of-scope';
const MODE_SENTENCE = 'Invalid value "bogus" for --mode. Allowed values: hitl, afk';
const KIND_SENTENCE =
  'Invalid value "bogus" for --kind. Allowed values: destination, notes, decision, research, work';

describe('enum rejections', () => {
  const CREATE = ['node', 'create', '--map', 'm', '--title', 't', '--kind', 'work', '--label', 'l'];
  // --kind is required on create, so a bad one replaces the good one rather
  // than sitting beside it.
  const CREATE_BAD_KIND = [
    'node',
    'create',
    '--map',
    'm',
    '--title',
    't',
    '--kind',
    'bogus',
    '--label',
    'l',
  ];

  it.each([
    ['create --status', [...CREATE, '--status', 'bogus'], STATUS_SENTENCE],
    ['create --mode', [...CREATE, '--mode', 'bogus'], MODE_SENTENCE],
    ['create --kind', CREATE_BAD_KIND, KIND_SENTENCE],
    ['update --status', ['node', 'update', '001', '--map', 'm', '--status', 'bogus'], STATUS_SENTENCE],
    ['update --mode', ['node', 'update', '001', '--map', 'm', '--mode', 'bogus'], MODE_SENTENCE],
    ['update --kind', ['node', 'update', '001', '--map', 'm', '--kind', 'bogus'], KIND_SENTENCE],
    ['list --status', ['node', 'list', '--map', 'm', '--status', 'bogus'], STATUS_SENTENCE],
    ['frontier --mode', ['node', 'frontier', '--map', 'm', '--mode', 'bogus'], MODE_SENTENCE],
  ])('%s speaks the project enum sentence', (_name, args, sentence) => {
    const result = runCli(args, { cwd: root });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(sentence);
  });
});

// ---------------------------------------------------------------------------
// A bad kind that no flag typed
//
// The enum sentence above belongs to the flag. A kind that arrives any other
// way – a hand-edited file, an issue label – is refused where it arrives, in
// that surface's own wording, and neither surface is a flag the user can be
// told to retype.
// ---------------------------------------------------------------------------

describe('kind from a stored file and from a label', () => {
  it('refuses a hand-edited file in the file schema wording, not the flag sentence', () => {
    const dir = join(root, 'spechub', 'maps', 'm');
    mkdirSync(dir, { recursive: true });
    const content =
      '---\nstatus: open\nmode: hitl\nkind: bogus\nlabel: "L"\nblocked-by: []\n---\n\n# T\n\nBody.\n';
    writeFileSync(join(dir, '001-t.md'), content);
    const result = runCli(['node', 'read', '001', '--map', 'm'], { cwd: root });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('001-t.md');
    expect(result.stderr).toContain('kind');
    expect(result.stderr).not.toContain('--kind');
  });

  it('refuses a bad kind label on the github backend in the adapter wording', () => {
    const payload = JSON.stringify([
      issue(1, 'map: demo · root: this · label: Ship it', ['map:demo', 'kind:bogus', 'root-node']),
    ]);
    const path = join(root, 'issues.json');
    writeFileSync(path, payload);
    const result = runPiped(`cat ${JSON.stringify(path)}`, ['node', 'diagram', '--stdin'], {
      cwd: root,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'is not allowed – one of: destination, notes, decision, research, work'
    );
    expect(result.stderr).not.toContain('--kind');
  });
});

// ---------------------------------------------------------------------------
// --body-file - and the stdin window
// ---------------------------------------------------------------------------

/** The create flags every stdin test below shares, minus the body source. */
const CREATE_ARGS = ['node', 'create', '--map', 'm', '--title', 't', '--kind', 'work', '--label', 'l'];

describe('--body-file -', () => {
  it('waits for a producer that answers half a second late', () => {
    // `readFileSync(0)` gives up here: fd 0 is an empty non-blocking pipe on
    // the first read, and the answer is EAGAIN rather than a wait.
    const create = runPiped('( sleep 0.5; echo hi )', [...CREATE_ARGS, '--body-file', '-'], {
      cwd: root,
    });
    expect(create.stderr).not.toContain('EAGAIN');
    expect(create.status).toBe(0);
    const read = runCli(['node', 'read', '001', '--map', 'm', '--json'], { cwd: root });
    expect(read.status).toBe(0);
    const parsed = JSON.parse(read.stdout) as NodeJson;
    expect(parsed.body).toContain('hi');
  });

  it('takes a body from a producer that answers at once', () => {
    const create = runPiped("printf 'a real body'", [...CREATE_ARGS, '--body-file', '-'], {
      cwd: root,
    });
    expect(create.status).toBe(0);
    const read = runCli(['node', 'read', '001', '--map', 'm', '--json'], { cwd: root });
    const parsed = JSON.parse(read.stdout) as NodeJson;
    expect(parsed.body).toContain('a real body');
  });

  // A producer killed halfway closes the pipe, and a synchronous read cannot
  // tell that from a clean end of input – both answer zero bytes. An empty body
  // is the one case it can tell, so it is the one case refused: a producer that
  // died before sending anything.
  it('refuses a pipe that hands over nothing at all', () => {
    const create = runPiped("printf ''", [...CREATE_ARGS, '--body-file', '-'], { cwd: root });
    expect(create.status).toBe(1);
    expect(create.stderr).toContain('stdin');
    expect(create.stderr).toMatch(/nothing/i);
  });
});

// ---------------------------------------------------------------------------
// --body-file - on a terminal
//
// Nothing is piped in, so the refusal has to name the flag the user can reach
// for instead. `node diagram --stdin` names `gh issue list` because that is its
// caller; `--body-file -` on `node create` has a different one and owes a
// different sentence.
// ---------------------------------------------------------------------------

describe('--body-file - on a terminal', () => {
  it('names --body, the flag that takes the text directly', () => {
    const result = runTty([...CREATE_ARGS, '--body-file', '-'], { cwd: root });
    expect(result.status).toBe(1);
    expect(result.text).toContain(
      '--body-file - reads piped input, and stdin is a terminal. Pipe it in, or use --body <text>.'
    );
  });

  it('never names `gh issue list`, a command this user never ran', () => {
    const result = runTty([...CREATE_ARGS, '--body-file', '-'], { cwd: root });
    expect(result.text).not.toContain('gh issue list');
  });

  it('keeps the `gh issue list` wording on node diagram --stdin, its real caller', () => {
    const result = runTty(['node', 'diagram', '--stdin'], { cwd: root });
    expect(result.status).toBe(1);
    expect(result.text).toContain('gh issue list');
  });
});

describe('stdin window', () => {
  const CHUNKS = ['chunk0', 'chunk1', 'chunk2', 'chunk3', 'chunk4'];

  it('takes every chunk from a producer that streams for longer than the window', () => {
    // The window measures silence, not total duration: the gaps are 100ms and
    // the run is about a second, so an absolute 400ms deadline would cut this
    // producer off part way and an idle one never fires at all.
    const producer = streamingProducer('stream.cjs', `${CHUNKS.join('\n')}\n`);
    const create = runPiped(producer, [...CREATE_ARGS, '--body-file', '-'], {
      cwd: root,
      env: { SPECHUB_STDIN_SILENCE_MS: '400' },
    });
    expect(create.status).toBe(0);
    const read = runCli(['node', 'read', '001', '--map', 'm', '--json'], { cwd: root });
    const parsed = JSON.parse(read.stdout) as NodeJson;
    for (const chunk of CHUNKS) expect(parsed.body).toContain(chunk);
  });

  it('refuses a pipe that opens and then stays silent past the window', () => {
    const create = runPiped(silentProducer('silent.cjs'), [...CREATE_ARGS, '--body-file', '-'], {
      cwd: root,
      env: { SPECHUB_STDIN_SILENCE_MS: '300' },
    });
    expect(create.status).toBe(1);
    // The window is a silence, so the message names one. The old wording
    // claimed nothing ever arrived, which is false whenever data had been
    // arriving right up to the gap that fired.
    expect(create.stderr).toMatch(/silen(ce|t)/i);
    expect(create.stderr).not.toContain('nothing arrived on stdin within');
  });

  it('takes a whole issue list from a slow producer on node diagram --stdin', () => {
    const producer = streamingProducer('issues.cjs', issuesJson());
    const result = runPiped(producer, ['node', 'diagram', '--stdin'], {
      cwd: root,
      env: { SPECHUB_STDIN_SILENCE_MS: '400' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('n101');
    expect(result.stdout).toContain('n102');
  });

  it('refuses a silent pipe on node diagram --stdin too', () => {
    const result = runPiped(silentProducer('silent-diagram.cjs'), ['node', 'diagram', '--stdin'], {
      cwd: root,
      env: { SPECHUB_STDIN_SILENCE_MS: '300' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/silen(ce|t)/i);
    expect(result.stderr).not.toContain('nothing arrived on stdin within');
  });

  it('names the knob that widens the window on the second line of the refusal', () => {
    // A genuinely slow producer is a real case, and the user hitting this has
    // to be told what to widen without going looking for it.
    const create = runPiped(silentProducer('silent-hint.cjs'), [...CREATE_ARGS, '--body-file', '-'], {
      cwd: root,
      env: { SPECHUB_STDIN_SILENCE_MS: '300' },
    });
    expect(create.status).toBe(1);
    const lines = create.stderr.trimEnd().split('\n');
    expect(lines[0]).toMatch(/silen(ce|t)/i);
    expect(lines[1]).toContain('SPECHUB_STDIN_SILENCE_MS');
  });

  it('ignores the old SPECHUB_STDIN_IDLE_MS name', () => {
    // A one-millisecond window would cut this producer off on the first read.
    // The old name opens no window, so the default thirty seconds stands and
    // the half-second wait is nothing.
    const create = runPiped('( sleep 0.5; echo hi )', [...CREATE_ARGS, '--body-file', '-'], {
      cwd: root,
      env: { SPECHUB_STDIN_IDLE_MS: '1' },
    });
    expect(create.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// node diagram, refusals
//
// Three mistakes, three messages: the map that is not there, no backend named,
// and both named at once. Each names only what its own reader got wrong.
// ---------------------------------------------------------------------------

describe('node diagram refusals', () => {
  it('names the map and its missing directory', () => {
    const result = runCli(['node', 'diagram', '--map', 'nope'], { cwd: root });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Map 'nope' does not exist");
    expect(result.stderr).toContain(join(root, 'spechub', 'maps', 'nope'));
    expect(result.stderr).toContain('directory');
  });

  it('names both backends when neither is given', () => {
    const result = runCli(['node', 'diagram'], { cwd: root });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Name a backend: --map <name> for the files backend, or --stdin for the github one.'
    );
  });

  it('says to use one, not both, when both are given', () => {
    const result = runCli(['node', 'diagram', '--map', 'm', '--stdin'], { cwd: root });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Use --map <name> for the files backend or --stdin for the github one, not both.'
    );
  });
});
