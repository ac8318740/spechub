import { describe, it, expect } from 'vitest';
import { LABEL_MAX_CHARS, LABEL_MAX_WORDS } from './nodes.js';
import { nodesFromIssues } from './github-issues.js';
import { renderDiagram } from './diagram.js';

// ---------------------------------------------------------------------------
// Building input
// ---------------------------------------------------------------------------

/**
 * One issue as `gh issue list --json number,title,body,state,stateReason,labels,url`
 * emits it. Issue numbers stay three digits throughout, so an assertion on the
 * id as text holds whether the renderer writes it bare, padded or with a hash.
 *
 * The default header carries only the fields the adapter reads. A `root:` field
 * appears on real issues and is deliberately absent here, because nothing under
 * test reads it and a default that carried it would suggest otherwise.
 */
function issue(opts: {
  number?: number;
  header?: string;
  body?: string;
  state?: string;
  stateReason?: string | null;
  labels?: string[];
  url?: string;
}) {
  const header = opts.header ?? 'map: demo · label: Ship it';
  const state = opts.state ?? 'OPEN';
  return {
    number: opts.number,
    title: `Issue ${opts.number}`,
    body: opts.body ?? `${header}\n\nSome prose.`,
    state,
    // gh writes the empty string on an open issue, not null.
    stateReason: opts.stateReason ?? (state === 'OPEN' ? '' : 'COMPLETED'),
    labels: (opts.labels ?? ['map:demo', 'kind:work']).map(name => ({ name })),
    url: opts.url ?? `https://github.com/acme/repo/issues/${opts.number}`,
  };
}

function issuesJson(...list: unknown[]): string {
  return JSON.stringify(list);
}

/** The GitHub map the rendering assertions below share: a root and one child. */
function githubPair(): string {
  return issuesJson(
    issue({
      number: 101,
      labels: ['map:demo', 'kind:destination', 'root-node'],
      header: 'map: demo · root: this · label: Ship it',
    }),
    issue({
      number: 102,
      labels: ['map:demo', 'kind:work'],
      header: 'map: demo · root: #101 · answers: #101 · label: Nodes in git?',
    })
  );
}

/**
 * The error a call throws, so a test can state both what kind of failure it is
 * and what it says. A call that returns instead fails here rather than leaving
 * the assertions below to pass over nothing.
 */
function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the call to throw, but it returned');
}

// ---------------------------------------------------------------------------

describe('parsing', () => {
  it('takes the issue number as the node id', () => {
    const nodes = nodesFromIssues(githubPair());
    expect(nodes.map(n => n.id).join(' ')).toContain('101');
    expect(nodes.map(n => n.id).join(' ')).toContain('102');
  });

  it('reads kind, mode and pinned from the labels', () => {
    const nodes = nodesFromIssues(
      issuesJson(
        issue({ number: 101, labels: ['map:demo', 'kind:decision', 'afk', 'pinned', 'root-node'] })
      )
    );
    expect(nodes[0].kind).toBe('decision');
    expect(nodes[0].mode).toBe('afk');
    expect(nodes[0].pinned).toBe(true);
  });

  it('takes an absent afk label as hitl and an absent pinned label as unpinned', () => {
    const nodes = nodesFromIssues(
      issuesJson(issue({ number: 101, labels: ['map:demo', 'kind:work', 'root-node'] }))
    );
    expect(nodes[0].mode).toBe('hitl');
    expect(nodes[0].pinned).toBe(false);
  });

  it.each<{
    name: string;
    state: string;
    stateReason: string | null;
    extra: string[];
    expected: string;
  }>([
    {
      name: 'an open issue labelled fog',
      state: 'OPEN',
      stateReason: '',
      extra: ['fog'],
      expected: 'fog',
    },
    {
      name: 'an open issue labelled claimed',
      state: 'OPEN',
      stateReason: '',
      extra: ['claimed'],
      expected: 'claimed',
    },
    {
      name: 'an open issue labelled neither',
      state: 'OPEN',
      stateReason: '',
      extra: [],
      expected: 'open',
    },
    {
      name: 'a closed issue completed',
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      extra: [],
      expected: 'resolved',
    },
    {
      name: 'a closed issue not planned',
      state: 'CLOSED',
      stateReason: 'NOT_PLANNED',
      extra: [],
      expected: 'out-of-scope',
    },
  ])('derives $name as $expected', ({ state, stateReason, extra, expected }) => {
    const nodes = nodesFromIssues(
      issuesJson(
        issue({
          number: 101,
          state,
          stateReason,
          labels: ['map:demo', 'kind:work', 'root-node', ...extra],
        })
      )
    );
    expect(nodes[0].status).toBe(expected);
  });

  it('reads answers, blocked-by and label from the header line', () => {
    const nodes = nodesFromIssues(
      issuesJson(
        issue({ number: 101, labels: ['map:demo', 'kind:destination', 'root-node'] }),
        issue({
          number: 114,
          header: 'map: demo · root: #101 · answers: #101 · label: Blocker one',
        }),
        issue({
          number: 117,
          header: 'map: demo · root: #101 · answers: #101 · label: Blocker two',
        }),
        issue({
          number: 119,
          header:
            'map: demo · root: #101 · answers: #101 · blocked-by: #114, #117 · label: Nodes in git?',
        })
      )
    );
    const node = nodes.find(n => n.id.includes('119'))!;
    expect(node.label).toBe('Nodes in git?');
    expect(node.answers).toContain('101');
    expect(node.blockedBy).toHaveLength(2);
    expect(node.blockedBy.join(' ')).toContain('114');
    expect(node.blockedBy.join(' ')).toContain('117');
  });

  it('gives the root no answers, and a node with no blocked-by no blockers', () => {
    const nodes = nodesFromIssues(githubPair());
    const rootNode = nodes.find(n => n.id.includes('101'))!;
    const child = nodes.find(n => n.id.includes('102'))!;
    expect(rootNode.answers).toBeUndefined();
    expect(rootNode.label).toBe('Ship it');
    expect(child.blockedBy).toEqual([]);
  });

  it('reads the empty stateReason gh writes on an open issue as no closure reason', () => {
    const nodes = nodesFromIssues(
      issuesJson(
        issue({
          number: 101,
          state: 'OPEN',
          stateReason: '',
          labels: ['map:demo', 'kind:work', 'root-node', 'fog'],
        })
      )
    );
    expect(nodes[0].status).toBe('fog');
  });

  it('rejects an issue with no kind label, naming the issue number', () => {
    const attempt = () =>
      nodesFromIssues(issuesJson(issue({ number: 142, labels: ['map:demo', 'root-node'] })));
    expect(attempt).toThrow('142');
    expect(attempt).toThrow(/kind/);
  });

  it('rejects an issue whose body has no header line, naming the issue number', () => {
    const attempt = () =>
      nodesFromIssues(issuesJson(issue({ number: 142, body: 'Just prose, no header.\n' })));
    expect(attempt).toThrow('142');
  });

  it('rejects a blocked-by naming an id not in the input, naming both ids', () => {
    const attempt = () =>
      nodesFromIssues(
        issuesJson(
          issue({ number: 101, labels: ['map:demo', 'kind:destination', 'root-node'] }),
          issue({
            number: 142,
            header: 'map: demo · root: #101 · answers: #101 · blocked-by: #999 · label: Waiting',
          })
        )
      );
    expect(attempt).toThrow('142');
    expect(attempt).toThrow('999');
  });
});

describe('malformed input', () => {
  it.each([
    [
      'a labels field that is a string rather than an array',
      () => ({ ...issue({ number: 142 }), labels: 'kind:work' }),
    ],
    [
      'a labels array holding a null',
      () => ({ ...issue({ number: 142 }), labels: [{ name: 'kind:work' }, null] }),
    ],
    ['a body that is a number', () => ({ ...issue({ number: 142 }), body: 42 })],
  ])('rejects %s, naming the issue', (_name, build) => {
    const err = thrownBy(() => nodesFromIssues(issuesJson(build())));
    // A raw TypeError names neither the issue nor the field, which is the whole
    // reason the shape has to be checked rather than tripped over.
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).toMatch(/issue 142/);
  });

  it('rejects an entry that is not an object at all, without a raw type error', () => {
    // No number to name, so this only states that the failure is a reported one.
    // What names the entry's position is left to whoever writes the message.
    const err = thrownBy(() => nodesFromIssues('[null]'));
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).not.toBe('');
  });

  it('rejects an issue with no number rather than drawing a node called undefined', () => {
    const err = thrownBy(() => nodesFromIssues(issuesJson(issue({}))));
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).not.toBe('');
  });
});

describe('map integrity', () => {
  it('rejects two issues sharing a number, naming the number twice over', () => {
    const attempt = () =>
      nodesFromIssues(
        issuesJson(
          issue({ number: 101, labels: ['map:demo', 'kind:destination', 'root-node'] }),
          issue({ number: 101, header: 'map: demo · answers: #101 · label: Second' })
        )
      );
    expect(attempt).toThrow(/duplicate/i);
    expect(attempt).toThrow('101');
  });

  it('rejects an issue carrying two kind labels, naming the issue', () => {
    const attempt = () =>
      nodesFromIssues(
        issuesJson(
          issue({ number: 142, labels: ['map:demo', 'kind:work', 'kind:decision', 'root-node'] })
        )
      );
    expect(attempt).toThrow(/issue 142/);
    expect(attempt).toThrow(/kind/);
  });

  it('rejects a blocked-by cycle, naming a node caught in it', () => {
    const attempt = () =>
      nodesFromIssues(
        issuesJson(
          issue({ number: 101, labels: ['map:demo', 'kind:destination', 'root-node'] }),
          issue({
            number: 102,
            header: 'map: demo · answers: #101 · blocked-by: #103 · label: First',
          }),
          issue({
            number: 103,
            header: 'map: demo · answers: #101 · blocked-by: #102 · label: Second',
          })
        )
      );
    expect(attempt).toThrow(/cycle/i);
    expect(attempt).toThrow('102');
  });
});

describe('label', () => {
  it.each([
    ['an empty label', ''],
    [
      'a label of too many words',
      Array.from({ length: LABEL_MAX_WORDS + 1 }, (_, at) => `w${at}`).join(' '),
    ],
    ['a label of too many characters', 'x'.repeat(LABEL_MAX_CHARS + 1)],
  ])('rejects %s, naming the issue', (_name, label) => {
    const attempt = () =>
      nodesFromIssues(issuesJson(issue({ number: 142, header: `map: demo · label: ${label}` })));
    expect(attempt).toThrow(/issue 142/);
  });

  it('keeps a middle dot inside the label, which runs to the end of the line', () => {
    const nodes = nodesFromIssues(
      issuesJson(
        issue({
          number: 101,
          labels: ['map:demo', 'kind:destination', 'root-node'],
          header: 'map: demo · label: A · B',
        })
      )
    );
    expect(nodes[0].label).toBe('A · B');
  });
});

describe('url', () => {
  it('never lets a url break out of the anchor it is written into', () => {
    // A single quote closes the href mermaid opened, and everything after it
    // lands as further attributes on the anchor.
    const url = "https://github.com/acme/repo/issues/101' onmouseover='steal()";
    const render = () =>
      renderDiagram(
        nodesFromIssues(
          issuesJson(issue({ number: 101, labels: ['map:demo', 'kind:destination'], url }))
        )
      );
    let out: string;
    try {
      out = render();
    } catch {
      // Refusing a url that is not a plain https link is the other answer the
      // requirement allows, and it closes the hole just as well.
      return;
    }
    const tags = out.match(/<a\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toMatch(/^<a href='[^'<>]*'>$/);
  });
});
