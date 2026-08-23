#!/usr/bin/env node
// opener.js - show a page from a VM in the browser on this laptop.
//
// The VM has no browser. This service is how a page it rendered reaches the
// one in front of the user. It listens on loopback, and the VM reaches it
// through its own reverse SSH tunnel on port 19989. That tunnel is a separate
// scheduled task from the one carrying the Playwriter relay, because
// ExitOnForwardFailure=yes fails the whole ssh over a single wedged port. One
// shared connection would let a stuck 19989 take the bridge down with it.
//
// It is deliberately NOT the bridge. The bridge drives a browser for an agent
// over the Chrome DevTools Protocol, attaches per tab, needs a manual arming
// click and lives in a separate Chrome profile. This hands a page to the
// user's DEFAULT browser with no click anywhere. See
// docs/adr/0006-document-opener-service.md.
//
// Node rather than PowerShell because the laptop already has Node for the
// relay, and because binding a socket needs no URL ACL reservation, so this
// runs as an ordinary user with no elevation.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = Number(process.env.SPECHUB_OPENER_PORT || 19989);
const HOME = process.env.LOCALAPPDATA || os.homedir();
const STATE = path.join(HOME, 'playwriter-bridge');
const DOCS = path.join(STATE, 'docs');
const ASSETS = path.join(STATE, 'assets');
const TOKEN_FILE = path.join(STATE, 'opener.token');
const LOG_FILE = path.join(STATE, 'opener.log');

// A document whose tab has polled within this window is still on screen, so a
// re-render updates it in place instead of opening a second tab. This is the
// whole of "new tab, but reuse if the same file": liveness observed, never
// assumed. A tab the user closed stops polling and the next render opens
// afresh, which is the behaviour you want and cannot get by remembering that
// you once opened it.
const LIVE_MS = 8000;

// Documents are capability URLs: the id is unguessable, so the browser - which
// cannot send our auth header - is still the only thing that can fetch one.
// Deriving it from the source path rather than at random is what makes the id
// stable across renders, which is what lets a tab be reused at all.
const DOC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

for (const d of [STATE, DOCS, ASSETS]) fs.mkdirSync(d, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* logging must never kill the service */ }
}

let TOKEN = '';
function loadToken() {
  try {
    TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    TOKEN = '';
  }
  return TOKEN;
}
loadToken();

// Re-read on every check rather than caching: register-tasks.ps1 may write the
// token after this service is already running, and a service that needed a
// restart to notice would look like a broken bridge to the VM.
function authorised(req) {
  const t = loadToken();
  if (!t) return false;
  const got = req.headers['x-spechub-token'];
  if (typeof got !== 'string' || got.length !== t.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(t));
}

function docId(key) {
  const t = loadToken();
  return crypto.createHmac('sha256', t || 'unset').update(key).digest('hex').slice(0, 24);
}

// id -> { version, title, lastPoll, opened }
const docs = new Map();

function docPath(id) { return path.join(DOCS, id + '.html'); }

function pruneDocs() {
  const cutoff = Date.now() - DOC_TTL_MS;
  let f;
  try { f = fs.readdirSync(DOCS); } catch { return; }
  for (const name of f) {
    const p = path.join(DOCS, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch { /* a file that vanished under us needs no pruning */ }
  }
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

// Hand the URL to whatever this machine considers the default browser. On
// Windows `start` is a cmd builtin, not a program, hence the shell; the empty
// string is start's title argument, which it otherwise takes from a quoted URL
// and then opens nothing. The other platforms are here because the laptop this
// runs on is not required to be Windows - only the bridge's relay is.
function openInBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err) => {
      if (err) log(`open failed for ${url}: ${err.message}`);
      resolve(!err);
    });
  });
}

// key and title arrive hex-encoded. A key is an absolute file path and a title
// a file name, and either may hold characters a query string cannot carry
// intact. Hex has no escaping rules to get wrong at either end.
function unhex(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(v)) return null;
  return Buffer.from(v, 'hex').toString('utf8');
}

function runPowerShell(command) {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout: 30000 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// The page polls for its own version and reloads when it changes. Injected
// here rather than produced by the renderer on the VM: the renderer's job is
// a standalone document, and a document that phones home to this service is
// only meaningful while this service is serving it.
function injectReloader(html, id) {
  const script = `
<script>
(function(){
  var id=${JSON.stringify(id)},cur=null;
  try{var y=sessionStorage.getItem('spechub-scroll-'+id);if(y)addEventListener('load',function(){scrollTo(0,+y)})}catch(e){}
  addEventListener('beforeunload',function(){try{sessionStorage.setItem('spechub-scroll-'+id,String(scrollY))}catch(e){}});
  setInterval(function(){
    fetch('/doc/'+id+'/version',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
      if(cur===null){cur=d.version;return}
      if(d.version!==cur){try{sessionStorage.setItem('spechub-scroll-'+id,String(scrollY))}catch(e){}location.reload()}
    }).catch(function(){});
  },1500);
})();
</script>`;
  return html.includes('</body>')
    ? html.replace(/<\/body>/i, script + '\n</body>')
    : html + script;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    // --- unauthenticated: the browser fetches these and cannot send a header.
    // The document id is the capability, which is why it is an HMAC and not a
    // counter.
    let m = p.match(/^\/doc\/([0-9a-f]{24})$/);
    if (m && req.method === 'GET') {
      const id = m[1];
      const entry = docs.get(id);
      let html;
      try { html = fs.readFileSync(docPath(id), 'utf8'); } catch { return json(res, 404, { error: 'no such document' }); }
      if (entry) entry.lastPoll = Date.now();
      const body = Buffer.from(injectReloader(html, id));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
      return res.end(body);
    }

    m = p.match(/^\/doc\/([0-9a-f]{24})\/version$/);
    if (m && req.method === 'GET') {
      const entry = docs.get(m[1]);
      if (!entry) return json(res, 404, { error: 'no such document' });
      entry.lastPoll = Date.now();
      return json(res, 200, { version: entry.version });
    }

    // Served from the copy the VM uploaded once. Without it, fall through to
    // the CDN so a diagram still draws rather than the page half-rendering.
    if (p === '/mermaid.js' && req.method === 'GET') {
      const local = path.join(ASSETS, 'mermaid.min.js');
      if (fs.existsSync(local)) {
        const body = fs.readFileSync(local);
        res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': body.length });
        return res.end(body);
      }
      res.writeHead(302, { location: 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js' });
      return res.end();
    }

    // --- everything below speaks to the VM and must carry the token.
    if (!authorised(req)) return json(res, 401, { error: 'bad or missing token' });

    if (p === '/health' && req.method === 'GET') {
      return json(res, 200, { opener: 1, port: PORT, docs: docs.size, mermaid: fs.existsSync(path.join(ASSETS, 'mermaid.min.js')) });
    }

    if (p === '/open' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      const target = String(body.url || '');
      // Only schemes a browser should be handed. Without this the VM could ask
      // for file:// or a custom protocol handler on this machine.
      if (!/^https?:\/\//i.test(target)) return json(res, 400, { error: 'only http and https URLs' });
      const ok = await openInBrowser(target);
      log(`open url ${target} -> ${ok}`);
      return json(res, ok ? 200 : 500, { opened: ok, url: target });
    }

    if (p === '/doc' && req.method === 'POST') {
      const key = unhex(url.searchParams.get('key'));
      if (!key) return json(res, 400, { error: 'key is required, hex-encoded' });
      const title = unhex(url.searchParams.get('title')) || key;
      const html = (await readBody(req, 32 * 1024 * 1024)).toString('utf8');
      if (!html) return json(res, 400, { error: 'empty document' });

      const id = docId(key);
      fs.writeFileSync(docPath(id), html, 'utf8');
      const entry = docs.get(id) || { version: 0, lastPoll: 0, opened: false };
      entry.version += 1;
      entry.title = title;
      docs.set(id, entry);

      const docUrl = `http://127.0.0.1:${PORT}/doc/${id}`;
      // A tab that polled a moment ago is still open, and will reload itself.
      // Opening again would leave the user with two tabs of the same document.
      const live = entry.opened && (Date.now() - entry.lastPoll) < LIVE_MS;
      let opened = false;
      if (!live) {
        opened = await openInBrowser(docUrl);
        entry.opened = opened;
      }
      pruneDocs();
      log(`doc ${title} -> ${docUrl} v${entry.version} ${live ? 'reused live tab' : 'opened new tab'}`);
      return json(res, 200, { url: docUrl, version: entry.version, reused: live, opened });
    }

    if (p === '/asset/mermaid.js' && req.method === 'POST') {
      const body = await readBody(req, 16 * 1024 * 1024);
      fs.writeFileSync(path.join(ASSETS, 'mermaid.min.js'), body);
      log(`cached mermaid.min.js (${body.length} bytes)`);
      return json(res, 200, { cached: true, bytes: body.length });
    }

    // --- the two recoveries the VM could not previously perform itself. Until
    // now these were handed to a human to paste into PowerShell. Arming the
    // extension is still not here, because it is a click in a third-party
    // extension and no amount of plumbing can press it.
    if (p === '/bridge/restart' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
      const what = String(body.what || 'both');
      // The two forwards are separate scheduled tasks - Playwriter-Tunnel-VM<n>
      // carries the relay's 19988, Playwriter-OpenerTunnel-VM<n> the opener's
      // 19989 - because ExitOnForwardFailure means one wedged port on a shared
      // connection would take both down. So "restart the tunnel" is two
      // patterns: 'Playwriter-Tunnel*' does not match the opener's task name,
      // and asking for it alone would leave the opener's forward dead and the
      // VM with no way to reach a browser.
      // 'both' is the relay and both tunnels, never everything under the
      // prefix: the opener itself runs as Playwriter-Opener, so 'Playwriter-*'
      // would stop the process serving this very request. The VM would get no
      // reply, and the one service that can restart anything would be down.
      const patterns = what === 'relay' ? ['Playwriter-Relay*']
        : what === 'tunnel' ? ['Playwriter-Tunnel*', 'Playwriter-OpenerTunnel*']
        : ['Playwriter-Relay', 'Playwriter-Tunnel*', 'Playwriter-OpenerTunnel*'];
      const taskNames = patterns.map((x) => `'${x}'`).join(',');
      const r = await runPowerShell(
        `Get-ScheduledTask -TaskName ${taskNames} -ErrorAction SilentlyContinue | ForEach-Object { Stop-ScheduledTask -TaskName $_.TaskName -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName $_.TaskName; $_.TaskName }`);
      log(`bridge restart ${what}: ok=${r.ok}`);
      return json(res, r.ok ? 200 : 500, { restarted: r.stdout.trim().split(/\r?\n/).filter(Boolean), error: r.ok ? null : r.stderr.trim() });
    }

    if (p === '/bridge/health' && req.method === 'GET') {
      const r = await runPowerShell(
        `Get-ScheduledTask -TaskName 'Playwriter-*' | ForEach-Object { "$($_.TaskName)=$($_.State)" }`);
      const tasks = {};
      for (const line of r.stdout.split(/\r?\n/)) {
        const i = line.indexOf('=');
        if (i > 0) tasks[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return json(res, 200, { tasks });
    }

    return json(res, 404, { error: 'no such endpoint' });
  } catch (err) {
    log(`error handling ${req.method} ${p}: ${err.message}`);
    return json(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`opener listening on 127.0.0.1:${PORT} (token ${loadToken() ? 'present' : 'MISSING'})`);
});

server.on('error', (err) => {
  log(`listen failed: ${err.message}`);
  process.exit(1);
});
