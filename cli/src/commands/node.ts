// The four tracker operations on the files backend: create, read, update,
// list. Frontier, claim and resolve are compositions performed by skills.
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { findProjectRoot } from '../lib/project.js';
import { requireProject } from '../lib/utils.js';
import {
  NODE_STATUSES,
  NODE_MODES,
  type MapNode,
  type NodeStatus,
  type NodeMode,
  createNode,
  deriveDepths,
  frontier,
  getNode,
  loadNodes,
  mapDir,
  updateNode,
  walkTree,
} from '../lib/nodes.js';

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

function parseStatus(value: string): NodeStatus {
  if (!(NODE_STATUSES as readonly string[]).includes(value)) {
    fail(`Invalid status '${value}'. One of: ${NODE_STATUSES.join(', ')}`);
  }
  return value as NodeStatus;
}

function parseMode(value: string): NodeMode {
  if (!(NODE_MODES as readonly string[]).includes(value)) {
    fail(`Invalid mode '${value}'. One of: ${NODE_MODES.join(', ')}`);
  }
  return value as NodeMode;
}

function parseIdList(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function readBody(body?: string, bodyFile?: string): string | undefined {
  if (body !== undefined && bodyFile !== undefined) {
    fail('Use --body or --body-file, not both.');
  }
  if (body !== undefined) return body;
  if (bodyFile === undefined) return undefined;
  if (bodyFile === '-') return readFileSync(0, 'utf-8');
  return readFileSync(bodyFile, 'utf-8');
}

function toJson(node: MapNode): Record<string, unknown> {
  return {
    id: node.id,
    title: node.title,
    status: node.status,
    mode: node.mode,
    kind: node.kind ?? null,
    answers: node.answers ?? null,
    'blocked-by': node.blockedBy,
    pinned: node.pinned,
    file: node.file,
  };
}

function printNode(node: MapNode): void {
  const flags = [node.kind, node.pinned ? 'pinned' : undefined].filter(Boolean).join(', ');
  const links = [
    node.answers ? `answers ${node.answers}` : 'root',
    node.blockedBy.length > 0 ? `blocked by ${node.blockedBy.join(', ')}` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  console.log(
    `${chalk.bold(node.id)}  ${node.status.padEnd(12)} ${node.mode.padEnd(4)} ${node.title}` +
      chalk.dim(`  (${links}${flags ? `; ${flags}` : ''})`)
  );
}

export function register(program: Command): void {
  const nodeCmd = program
    .command('node')
    .description(
      'Map nodes: small markdown records, one file each, under spechub/maps/<name>/.\n' +
        'Status: fog (not yet stated precisely), open (ready), claimed (being worked),\n' +
        'resolved (settled), out-of-scope (dropped).'
    );

  nodeCmd
    .command('create')
    .description('Create a node; the first node in a map is the root')
    .requiredOption('--map <name>', 'map name')
    .requiredOption('--title <title>', 'node title')
    .option('--status <status>', `one of: ${NODE_STATUSES.join(', ')}`, parseStatus)
    .option('--mode <mode>', 'hitl (a human settles it) or afk (an agent settles it alone)', parseMode)
    .option('--kind <kind>', 'free-text label for what kind of node this is (grilling, research, task, ...) – advisory only')
    .option('--answers <id>', 'the node whose resolution raised this one (its provenance parent) – required except on the root')
    .option('--blocked-by <ids>', 'comma-separated ids of nodes that must settle before this one can be worked', parseIdList)
    .option('--pinned', 'load in full every session')
    .option('--body <text>', 'markdown body')
    .option('--body-file <path>', 'read body from file, or - for stdin')
    .option('--json', 'output as JSON')
    .action(
      (opts: {
        map: string;
        title: string;
        status?: NodeStatus;
        mode?: NodeMode;
        kind?: string;
        answers?: string;
        blockedBy?: string[];
        pinned?: boolean;
        body?: string;
        bodyFile?: string;
        json?: boolean;
      }) => {
        const root = findProjectRoot();
        requireProject(root);
        try {
          const node = createNode(root, opts.map, {
            title: opts.title,
            status: opts.status,
            mode: opts.mode,
            kind: opts.kind,
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
        } catch (err) {
          fail((err as Error).message);
        }
      }
    );

  nodeCmd
    .command('read')
    .description('Print one node in full')
    .argument('<id>', 'node id')
    .requiredOption('--map <name>', 'map name')
    .option('--json', 'output as JSON with body')
    .action((id: string, opts: { map: string; json?: boolean }) => {
      const root = findProjectRoot();
      requireProject(root);
      try {
        const node = getNode(root, opts.map, id);
        if (opts.json) {
          console.log(JSON.stringify({ ...toJson(node), body: node.body }, null, 2));
        } else {
          console.log(readFileSync(join(mapDir(root, opts.map), node.file), 'utf-8'));
        }
      } catch (err) {
        fail((err as Error).message);
      }
    });

  nodeCmd
    .command('update')
    .description('Update node fields or body')
    .argument('<id>', 'node id')
    .requiredOption('--map <name>', 'map name')
    .option('--title <title>', 'new title (the filename keeps its original slug)')
    .option('--status <status>', `one of: ${NODE_STATUSES.join(', ')}`, parseStatus)
    .option('--mode <mode>', `one of: ${NODE_MODES.join(', ')}`, parseMode)
    .option('--kind <kind>', 'advisory kind hint; empty string clears it')
    .option('--answers <id>', 'new provenance parent')
    .option('--blocked-by <ids>', 'comma-separated blocking ids; empty string clears', parseIdList)
    .option('--pinned <bool>', 'true or false')
    .option('--body <text>', 'replace the body')
    .option('--body-file <path>', 'replace the body from file, or - for stdin')
    .option('--append-body <text>', 'append to the body')
    .option('--json', 'output as JSON')
    .action(
      (
        id: string,
        opts: {
          map: string;
          title?: string;
          status?: NodeStatus;
          mode?: NodeMode;
          kind?: string;
          answers?: string;
          blockedBy?: string[];
          pinned?: string;
          body?: string;
          bodyFile?: string;
          appendBody?: string;
          json?: boolean;
        }
      ) => {
        const root = findProjectRoot();
        requireProject(root);
        if (opts.pinned !== undefined && opts.pinned !== 'true' && opts.pinned !== 'false') {
          fail(`--pinned takes true or false, got '${opts.pinned}'`);
        }
        try {
          const node = updateNode(root, opts.map, id, {
            title: opts.title,
            status: opts.status,
            mode: opts.mode,
            kind: opts.kind === '' ? null : opts.kind,
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
        } catch (err) {
          fail((err as Error).message);
        }
      }
    );

  nodeCmd
    .command('frontier')
    .description(
      'Open nodes with no unresolved blockers, shallowest first (fewest answers links from the root)'
    )
    .requiredOption('--map <name>', 'map name')
    .option('--mode <mode>', `filter by mode: ${NODE_MODES.join(', ')}`, parseMode)
    .option('--json', 'output as JSON')
    .action((opts: { map: string; mode?: NodeMode; json?: boolean }) => {
      const root = findProjectRoot();
      requireProject(root);
      try {
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
      } catch (err) {
        fail((err as Error).message);
      }
    });

  nodeCmd
    .command('walk')
    .description(
      'Reading-order dump of the whole map for handoff – parents before children, ' +
        'pinned nodes and the root in full, the rest as one-line summaries'
    )
    .requiredOption('--map <name>', 'map name')
    .option('--full', 'emit every body, not only pinned nodes and the root')
    .option('--json', 'output as JSON')
    .action((opts: { map: string; full?: boolean; json?: boolean }) => {
      const root = findProjectRoot();
      requireProject(root);
      try {
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
            node.pinned ? 'pinned' : undefined,
            node.blockedBy.length > 0 ? `blocked by ${node.blockedBy.join(', ')}` : undefined,
          ]
            .filter(Boolean)
            .join(', ');
          const body = inFull(node, depth) ? node.body.trim() : '';
          sections.push(`${heading} ${node.id} – ${node.title}\n(${meta})${body ? `\n\n${body}` : ''}`);
        }
        console.log(sections.join('\n\n'));
      } catch (err) {
        fail((err as Error).message);
      }
    });

  nodeCmd
    .command('list')
    .description('List nodes in a map')
    .requiredOption('--map <name>', 'map name')
    .option('--status <status>', `filter by status: ${NODE_STATUSES.join(', ')}`, parseStatus)
    .option('--json', 'output as JSON')
    .action((opts: { map: string; status?: NodeStatus; json?: boolean }) => {
      const root = findProjectRoot();
      requireProject(root);
      try {
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
      } catch (err) {
        fail((err as Error).message);
      }
    });
}
