// The four tracker operations on the files backend: create, read, update,
// list. Frontier, claim and resolve are compositions performed by skills.
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { fail, inProject, readStdin } from '../lib/utils.js';
import { invalidEnumValue } from '../lib/global-config.js';
import { renderDiagram, stripDiagrams } from '../lib/diagram.js';
import { nodesFromIssues } from '../lib/github-issues.js';
import {
  NODE_STATUSES,
  NODE_MODES,
  NODE_KINDS,
  ALLOWED_KINDS_SENTENCE,
  LABEL_CAP_SENTENCE,
  oneOf,
  type MapNode,
  type NodeStatus,
  type NodeMode,
  type NodeKind,
  createNode,
  deriveDepths,
  frontier,
  getNode,
  loadNodes,
  mapDir,
  updateNode,
  walkTree,
} from '../lib/nodes.js';

/**
 * A commander parser for one enum flag: it takes the value through, or refuses
 * it in the project's own enum sentence.
 *
 * `invalidEnumValue` composes that sentence for the global config too, so a
 * user who learns to read one rejection reads every other one the same way.
 */
function parseEnum<T extends string>(flag: string, values: readonly T[]) {
  return (value: string): T => {
    if (!(values as readonly string[]).includes(value)) {
      fail(invalidEnumValue(flag, value, values).message);
    }
    return value as T;
  };
}

const parseStatus = parseEnum('--status', NODE_STATUSES);
const parseMode = parseEnum('--mode', NODE_MODES);
const parseKind = parseEnum('--kind', NODE_KINDS);

function parseIdList(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// The terminal refusal `--body-file -` owes its own reader. `readStdin` names
// the `gh issue list` pipe by default, and a user typing this flag never ran
// that command.
const BODY_FILE_ON_TTY =
  '--body-file - reads piped input, and stdin is a terminal. ' +
  'Pipe it in, or use --body <text>.';

function readBody(body?: string, bodyFile?: string): string | undefined {
  if (body !== undefined && bodyFile !== undefined) {
    fail('Use --body or --body-file, not both.');
  }
  if (body !== undefined) return body;
  if (bodyFile === undefined) return undefined;
  // `readStdin` and never `readFileSync(0)`: a producer slower to answer than
  // this process is to start leaves fd 0 an empty non-blocking pipe, and the
  // plain read answers EAGAIN rather than waiting for the first byte.
  if (bodyFile === '-') {
    const piped = readStdin(BODY_FILE_ON_TTY);
    // A producer killed mid-stream closes the pipe, and a synchronous read
    // cannot tell that from a clean end of input – both hand over zero bytes.
    // An empty body is the one case it can tell, so it is the one case
    // refused. This is a guard against a producer that died before sending
    // anything, and never a guarantee that a body which arrived is whole.
    if (piped === '') {
      fail('nothing arrived on stdin – --body-file - was handed an empty pipe.');
    }
    return piped;
  }
  return readFileSync(bodyFile, 'utf-8');
}

function toJson(node: MapNode): Record<string, unknown> {
  return {
    id: node.id,
    title: node.title,
    status: node.status,
    mode: node.mode,
    kind: node.kind,
    label: node.label,
    answers: node.answers ?? null,
    'blocked-by': node.blockedBy,
    pinned: node.pinned,
    file: node.file,
  };
}

// A generated block repeats what the map itself already holds, so the
// human-readable output drops it and this flag puts it back. `--json` is the
// machine path and always carries the whole body, whatever this flag says.
const VISUALS_HELP = 'keep the generated diagram blocks this command otherwise strips';

// Both the one-line print and the walk summary name a label the same way. The
// quoting is what keeps a label holding a comma readable inside a list.
function labelFragment(node: MapNode): string {
  return `label ${JSON.stringify(node.label)}`;
}

function printNode(node: MapNode): void {
  const flags = [node.kind, labelFragment(node), node.pinned ? 'pinned' : undefined]
    .filter(Boolean)
    .join(', ');
  const links = [
    node.answers ? `answers ${node.answers}` : 'root',
    node.blockedBy.length > 0 ? `blocked by ${node.blockedBy.join(', ')}` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  console.log(
    `${chalk.bold(node.id)}  ${node.status.padEnd(12)} ${node.mode.padEnd(4)} ${node.title}` +
      chalk.dim(`  (${links}; ${flags})`)
  );
}

/** The flags `node create` takes, as commander hands them to the action. */
interface CreateOptions {
  map: string;
  title: string;
  status?: NodeStatus;
  mode?: NodeMode;
  kind: NodeKind;
  label: string;
  answers?: string;
  blockedBy?: string[];
  pinned?: boolean;
  body?: string;
  bodyFile?: string;
  json?: boolean;
}

/** The flags `node update` takes, as commander hands them to the action. */
interface UpdateOptions {
  map: string;
  title?: string;
  status?: NodeStatus;
  mode?: NodeMode;
  kind?: NodeKind;
  label?: string;
  answers?: string;
  blockedBy?: string[];
  pinned?: string;
  body?: string;
  bodyFile?: string;
  appendBody?: string;
  json?: boolean;
}

function registerCreate(nodeCmd: Command): void {
  nodeCmd
    .command('create')
    .description('Create a node; the first node in a map is the root')
    .requiredOption('--map <name>', 'map name')
    .requiredOption('--title <title>', 'node title')
    .option('--status <status>', oneOf(NODE_STATUSES), parseStatus)
    .option('--mode <mode>', 'hitl (a human settles it) or afk (an agent settles it alone)', parseMode)
    .requiredOption('--kind <kind>', ALLOWED_KINDS_SENTENCE, parseKind)
    .requiredOption('--label <label>', `short name for diagrams: ${LABEL_CAP_SENTENCE}`)
    .option('--answers <id>', 'the node whose resolution raised this one (its provenance parent) – required except on the root')
    .option('--blocked-by <ids>', 'comma-separated ids of nodes that must settle before this one can be worked', parseIdList)
    .option('--pinned', 'load in full every session')
    .option('--body <text>', 'markdown body')
    .option('--body-file <path>', 'read body from file, or - for stdin')
    .option('--json', 'output as JSON')
    .action(
      inProject((root, opts: CreateOptions) => {
        const node = createNode(root, opts.map, {
          title: opts.title,
          status: opts.status,
          mode: opts.mode,
          kind: opts.kind,
          label: opts.label,
          answers: opts.answers,
          blockedBy: opts.blockedBy,
          pinned: opts.pinned,
          body: readBody(opts.body, opts.bodyFile),
        });
        if (opts.json) {
          console.log(JSON.stringify(toJson(node), null, 2));
        } else {
          console.log(chalk.green(`Created ${node.id} in map '${opts.map}' (${node.file})`));
        }
      })
    );
}

function registerRead(nodeCmd: Command): void {
  nodeCmd
    .command('read')
    .description('Print one node in full')
    .argument('<id>', 'node id')
    .requiredOption('--map <name>', 'map name')
    .option('--json', 'output as JSON with body')
    .option('--visuals', VISUALS_HELP)
    .action(
      inProject((root, id: string, opts: { map: string; json?: boolean; visuals?: boolean }) => {
        const node = getNode(root, opts.map, id);
        if (opts.json) {
          console.log(JSON.stringify({ ...toJson(node), body: node.body }, null, 2));
        } else {
          const text = readFileSync(join(mapDir(root, opts.map), node.file), 'utf-8');
          console.log(opts.visuals ? text : stripDiagrams(text));
        }
      })
    );
}

function registerUpdate(nodeCmd: Command): void {
  nodeCmd
    .command('update')
    .description('Update node fields or body')
    .argument('<id>', 'node id')
    .requiredOption('--map <name>', 'map name')
    .option('--title <title>', 'new title (the filename keeps its original slug)')
    .option('--status <status>', oneOf(NODE_STATUSES), parseStatus)
    .option('--mode <mode>', oneOf(NODE_MODES), parseMode)
    .option('--kind <kind>', ALLOWED_KINDS_SENTENCE, parseKind)
    .option('--label <label>', `new short name for diagrams: ${LABEL_CAP_SENTENCE}`)
    .option('--answers <id>', 'new provenance parent')
    .option('--blocked-by <ids>', 'comma-separated blocking ids; empty string clears', parseIdList)
    .option('--pinned <bool>', 'true or false')
    .option('--body <text>', 'replace the body')
    .option('--body-file <path>', 'replace the body from file, or - for stdin')
    .option('--append-body <text>', 'append to the body')
    .option('--json', 'output as JSON')
    .action(
      inProject((root, id: string, opts: UpdateOptions) => {
        // `fail` exits the process, so this rejection never reaches the
        // wrapper's catch. It reads as its own refusal either way.
        if (opts.pinned !== undefined && opts.pinned !== 'true' && opts.pinned !== 'false') {
          fail(`--pinned takes true or false, got '${opts.pinned}'`);
        }
        const node = updateNode(root, opts.map, id, {
          title: opts.title,
          status: opts.status,
          mode: opts.mode,
          kind: opts.kind,
          label: opts.label,
          answers: opts.answers,
          blockedBy: opts.blockedBy,
          pinned: opts.pinned === undefined ? undefined : opts.pinned === 'true',
          body: readBody(opts.body, opts.bodyFile),
          appendBody: opts.appendBody,
        });
        if (opts.json) {
          console.log(JSON.stringify(toJson(node), null, 2));
        } else {
          console.log(chalk.green(`Updated ${node.id} in map '${opts.map}'`));
          printNode(node);
        }
      })
    );
}

function registerFrontier(nodeCmd: Command): void {
  nodeCmd
    .command('frontier')
    .description(
      'Open nodes with no unresolved blockers, shallowest first (fewest answers links from the root)'
    )
    .requiredOption('--map <name>', 'map name')
    .option('--mode <mode>', `filter by mode: ${NODE_MODES.join(', ')}`, parseMode)
    .option('--json', 'output as JSON')
    .action(
      inProject((root, opts: { map: string; mode?: NodeMode; json?: boolean }) => {
        const nodes = loadNodes(root, opts.map);
        const depths = deriveDepths(nodes);
        let ready = frontier(nodes);
        if (opts.mode) ready = ready.filter(n => n.mode === opts.mode);
        if (opts.json) {
          console.log(
            JSON.stringify(
              ready.map(n => ({ ...toJson(n), depth: depths.get(n.id) })),
              null,
              2
            )
          );
          return;
        }
        if (ready.length === 0) {
          console.log(chalk.dim(`Frontier of map '${opts.map}' is empty.`));
          return;
        }
        for (const node of ready) printNode(node);
      })
    );
}

function registerWalk(nodeCmd: Command): void {
  nodeCmd
    .command('walk')
    .description(
      'Reading-order dump of the whole map for handoff – parents before children, ' +
        'pinned nodes and the root in full, the rest as one-line summaries'
    )
    .requiredOption('--map <name>', 'map name')
    .option('--full', 'emit every body, not only pinned nodes and the root')
    .option('--json', 'output as JSON')
    .option('--visuals', VISUALS_HELP)
    .action(
      inProject((root, opts: { map: string; full?: boolean; json?: boolean; visuals?: boolean }) => {
        const entries = walkTree(loadNodes(root, opts.map));
        const inFull = (node: MapNode, depth: number): boolean =>
          Boolean(opts.full) || node.pinned || depth === 0;
        if (opts.json) {
          console.log(
            JSON.stringify(
              entries.map(({ node, depth }) => ({
                ...toJson(node),
                depth,
                ...(inFull(node, depth) ? { body: node.body } : {}),
              })),
              null,
              2
            )
          );
          return;
        }
        if (entries.length === 0) {
          console.log(chalk.dim(`Map '${opts.map}' has no nodes.`));
          return;
        }
        const sections: string[] = [];
        for (const { node, depth } of entries) {
          const heading = '#'.repeat(Math.min(depth + 1, 6));
          const meta = [
            node.status,
            node.mode,
            node.kind,
            labelFragment(node),
            node.pinned ? 'pinned' : undefined,
            node.blockedBy.length > 0 ? `blocked by ${node.blockedBy.join(', ')}` : undefined,
          ]
            .filter(Boolean)
            .join(', ');
          const full = opts.visuals ? node.body : stripDiagrams(node.body);
          const body = inFull(node, depth) ? full.trim() : '';
          sections.push(`${heading} ${node.id} – ${node.title}\n(${meta})${body ? `\n\n${body}` : ''}`);
        }
        console.log(sections.join('\n\n'));
      })
    );
}

function registerDiagram(nodeCmd: Command): void {
  nodeCmd
    .command('diagram')
    .description(
      'Render the map as mermaid, wrapped in the replaceable diagram markers.\n' +
        'Reads the files backend with --map, or a `gh issue list --json ' +
        'number,title,body,state,stateReason,labels,url` pipe with --stdin.'
    )
    .option('--map <name>', 'map name (files backend)')
    .option('--stdin', 'read the github issue list as JSON from stdin')
    .option('--from <id>', 'draw this node and its descendants only, rather than the whole map')
    .action(
      inProject((root, opts: { map?: string; stdin?: boolean; from?: string }) => {
        // The two backends are exclusive, and passing neither is a different
        // mistake from passing both. One message for each, so neither reader is
        // told about a flag they did not use.
        if (opts.map && opts.stdin) {
          fail('Use --map <name> for the files backend or --stdin for the github one, not both.');
        }
        if (!opts.map && !opts.stdin) {
          fail('Name a backend: --map <name> for the files backend, or --stdin for the github one.');
        }
        let nodes;
        if (opts.stdin) {
          nodes = nodesFromIssues(readStdin());
        } else {
          const map = opts.map as string;
          // A map that does not exist reads as an empty one, and an empty one
          // is what "the map has no nodes" reports - so a typo in the name came
          // back as a claim about the map the reader meant.
          if (!existsSync(mapDir(root, map))) {
            fail(`Map '${map}' does not exist - there is no ${mapDir(root, map)} directory.`);
          }
          nodes = loadNodes(root, map);
        }
        console.log(renderDiagram(nodes, { from: opts.from }));
      })
    );
}

function registerList(nodeCmd: Command): void {
  nodeCmd
    .command('list')
    .description('List nodes in a map')
    .requiredOption('--map <name>', 'map name')
    .option('--status <status>', `filter by status: ${NODE_STATUSES.join(', ')}`, parseStatus)
    .option('--json', 'output as JSON')
    .action(
      inProject((root, opts: { map: string; status?: NodeStatus; json?: boolean }) => {
        let nodes = loadNodes(root, opts.map);
        if (opts.status) nodes = nodes.filter(n => n.status === opts.status);
        if (opts.json) {
          console.log(JSON.stringify(nodes.map(toJson), null, 2));
          return;
        }
        if (nodes.length === 0) {
          console.log(chalk.dim(`No nodes${opts.status ? ` with status ${opts.status}` : ''} in map '${opts.map}'.`));
          return;
        }
        for (const node of nodes) printNode(node);
      })
    );
}

function registerKinds(nodeCmd: Command): void {
  // No `--map` and no project: the set of kinds is the code's, not any one
  // map's. A tracker materialising a map reads it from here to create its
  // `kind:<value>` labels, so the shell loop that does it holds no copy.
  nodeCmd
    .command('kinds')
    .description('Print the node kinds, one per line – the set a tracker turns into labels')
    .option('--json', 'output as JSON')
    .action((opts: { json?: boolean }) => {
      if (opts.json) {
        console.log(JSON.stringify([...NODE_KINDS]));
        return;
      }
      for (const kind of NODE_KINDS) console.log(kind);
    });
}

export function register(program: Command): void {
  const nodeCmd = program
    .command('node')
    .description(
      'Map nodes: small markdown records, one file each, under spechub/maps/<name>/.\n' +
        'Status: fog (not yet stated precisely), open (ready), claimed (being worked),\n' +
        'resolved (settled), out-of-scope (dropped).'
    );

  registerCreate(nodeCmd);
  registerRead(nodeCmd);
  registerUpdate(nodeCmd);
  registerFrontier(nodeCmd);
  registerWalk(nodeCmd);
  registerDiagram(nodeCmd);
  registerList(nodeCmd);
  registerKinds(nodeCmd);
}
