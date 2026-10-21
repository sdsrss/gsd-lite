// The updater on a network that reaches GitHub only through a proxy.
//
// Node's built-in fetch ignores HTTPS_PROXY unless the process opts in. On such
// a network every update check failed after 3s and said nothing — update-state
// recorded only lastCheck — so an install stopped updating for good, with no
// way for its user to find out (measured 2026-10-21: 0.13.0 a month behind).
//
// Per the Node docs there are two ways in: NODE_USE_ENV_PROXY=1 read at
// startup (fetch: v22.21.0+, v24.0.0+), which session-init sets on the child it
// spawns, and http.setGlobalProxyFromEnv() at runtime (v24.14.0+, v25.4.0+),
// for `gsd update`, which runs in a process nobody started that way.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const SOURCE = join(import.meta.dirname, '..', 'hooks', 'gsd-auto-update.cjs');
const LIB_DIR = join(import.meta.dirname, '..', 'hooks', 'lib');
const mod = require(SOURCE);

describe('which way the updater reaches the network', () => {
  const PROXY = { HTTPS_PROXY: 'http://127.0.0.1:9' };
  const calls = [];
  const withRuntime = { setGlobalProxyFromEnv: () => calls.push('runtime') };
  const withoutRuntime = {};

  it('premise: the module exports the route', () => {
    assert.equal(typeof mod.envProxyRoute, 'function');
    assert.equal(typeof mod.nodeReadsProxyEnvAtStartup, 'function');
  });

  for (const [label, env, version, http, route, enabled] of [
    ['no proxy in the environment', {}, '26.8.1', withRuntime, 'direct', false],
    ['started with NODE_USE_ENV_PROXY=1 on a Node that reads it', { ...PROXY, NODE_USE_ENV_PROXY: '1' }, '22.21.0', withoutRuntime, 'startup', false],
    ['started with it on a Node that ignores it, but has the runtime switch', { ...PROXY, NODE_USE_ENV_PROXY: '1' }, '22.20.0', withRuntime, 'runtime', true],
    ['started with it on a Node with neither', { ...PROXY, NODE_USE_ENV_PROXY: '1' }, '20.19.0', withoutRuntime, 'unsupported', false],
    ['not started with it, the runtime switch exists', { ...PROXY }, '24.14.0', withRuntime, 'runtime', true],
    ['not started with it, no runtime switch', { ...PROXY }, '24.13.0', withoutRuntime, 'unsupported', false],
    ['the user turned it off', { ...PROXY, NODE_USE_ENV_PROXY: '0' }, '26.8.1', withRuntime, 'opted-out', false],
    ['only a lower-case http_proxy', { http_proxy: 'http://127.0.0.1:9' }, '26.8.1', withRuntime, 'runtime', true],
  ]) {
    it(`${label} → ${route}`, () => {
      calls.length = 0;
      assert.equal(mod.envProxyRoute({ env, version, http }), route);
      assert.deepEqual(calls, enabled ? ['runtime'] : [], enabled ? 'the runtime switch is turned on' : 'and nothing global is changed');
    });
  }

  for (const [version, reads] of [['20.19.0', false], ['22.20.0', false], ['22.21.0', true], ['23.11.0', false], ['24.0.0', true], ['26.8.1', true], ['v24.0.0', true]]) {
    it(`Node ${version} ${reads ? 'reads' : 'does not read'} NODE_USE_ENV_PROXY at startup`, () => {
      assert.equal(mod.nodeReadsProxyEnvAtStartup(version), reads);
    });
  }
});

// The table above is this file's model of Node. This checks the model against
// the Node actually running — on each CI matrix version — by sending a request
// through a local proxy: when the route says the proxy is in use the proxy must
// see the request, and when it says not, it must not.
describe('the route matches what this Node really does', () => {
  async function withProxy(fn) {
    const seen = [];
    const server = createServer((req, res) => { seen.push(`${req.method} ${req.url} host=${req.headers.host}`); res.end('ok'); });
    // A CONNECT tunnel is answered and then parsed as HTTP by the same server,
    // so a tunnelled request lands in `seen` too.
    server.on('connect', (req, socket) => {
      seen.push(`CONNECT ${req.url}`);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      server.emit('connection', socket);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      return await fn(`http://127.0.0.1:${server.address().port}`, seen);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  // The child gets a clean proxy environment: this machine's own proxy and
  // NO_PROXY must not decide the answer.
  function childEnv(proxyUrl, extra) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(https?|no|all)_proxy$/i.test(key) || key === 'NODE_USE_ENV_PROXY' || key.startsWith('NODE_TEST')) delete env[key];
    }
    return { ...env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ...extra };
  }

  function probe(env) {
    const script = `
      const route = require(${JSON.stringify(SOURCE)}).envProxyRoute();
      fetch('http://gsd-proxy-probe.invalid/probe', { signal: AbortSignal.timeout(5000) })
        .then((res) => res.status, (err) => err.cause?.code || err.name)
        .then((outcome) => { console.log(JSON.stringify({ route, outcome })); process.exit(0); });`;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('error', reject);
      child.on('close', () => {
        try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { reject(new Error(`no result: ${out}`)); }
      });
    });
  }

  for (const [label, extra] of [
    ['a child started the way session-init starts the updater', { NODE_USE_ENV_PROXY: '1' }],
    ['a process started without it, like `gsd update`', {}],
  ]) {
    it(label, async () => {
      await withProxy(async (proxyUrl, seen) => {
        const { route, outcome } = await probe(childEnv(proxyUrl, extra));
        const proxied = seen.some((line) => line.includes('gsd-proxy-probe.invalid'));
        const claimsProxy = route === 'startup' || route === 'runtime';
        assert.ok(['startup', 'runtime', 'unsupported'].includes(route), `route ${route} on Node ${process.versions.node}`);
        assert.equal(proxied, claimsProxy,
          `Node ${process.versions.node}: route ${route}, but the proxy ${proxied ? 'saw' : 'did not see'} the request (outcome ${outcome}; proxy log ${JSON.stringify(seen)})`);
      });
    });
  }
});

describe('a failed check says why', () => {
  const route = (r) => ({ route: r, version: '20.19.0' });

  for (const [label, failure, expected] of [
    ['an HTTP error', { status: 502 }, 'HTTP 502'],
    ['a refused connection', { err: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }, 'ECONNREFUSED'],
    ['our own timeout', { err: Object.assign(new Error('aborted'), { name: 'AbortError' }) }, 'no response within 3s'],
    ['an unreadable body', { err: new SyntaxError('Unexpected token') }, 'unreadable response'],
  ]) {
    it(`names ${label}`, () => {
      assert.equal(mod.describeFetchFailure(failure, route('direct')), expected);
    });
  }

  // The reason reaches the model through SessionStart, and a proxy URL can
  // carry credentials. Only codes and numbers this module chose are used.
  it('never repeats the error text', () => {
    const err = Object.assign(new TypeError('fetch failed via http://user:secret@proxy:8080'), {
      cause: { code: 'connect to http://user:secret@proxy:8080', message: 'user:secret' },
    });
    const reason = mod.describeFetchFailure({ err }, route('runtime'));
    assert.doesNotMatch(reason, /secret|user|proxy:8080/);
    assert.match(reason, /^network error/);
  });

  for (const [r, version, pattern] of [
    ['startup', '24.0.0', /through the proxy set in the environment/],
    ['runtime', '26.8.1', /through the proxy set in the environment/],
    ['opted-out', '26.8.1', /NODE_USE_ENV_PROXY keeps Node from using it/],
    ['unsupported', '22.21.0', /only when started with NODE_USE_ENV_PROXY=1/],
    ['unsupported', '20.19.0', /cannot use one: it needs v22\.21\+ or v24\+/],
  ]) {
    it(`says what the proxy did when the route was ${r} on Node ${version}`, () => {
      assert.match(mod.describeFetchFailure({ status: 500 }, { route: r, version }), pattern);
    });
  }

  it('says nothing about a proxy when there is none', () => {
    assert.equal(mod.describeFetchFailure({ status: 500 }, route('direct')), 'HTTP 500');
  });
});

describe('repeated check failures are recorded and announced', () => {
  async function manualInstall() {
    const root = await mkdtemp(join(tmpdir(), 'gsd-proxy-'));
    const claudeDir = join(root, 'home', '.claude');
    await mkdir(join(claudeDir, 'hooks', 'lib'), { recursive: true });
    await mkdir(join(claudeDir, 'gsd'), { recursive: true });
    cpSync(SOURCE, join(claudeDir, 'hooks', 'gsd-auto-update.cjs'));
    cpSync(LIB_DIR, join(claudeDir, 'hooks', 'lib'), { recursive: true });
    await writeFile(join(claudeDir, 'gsd', 'package.json'), JSON.stringify({ name: 'gsd-lite', version: '0.3.0' }));
    const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, PLUGIN_AUTO_UPDATE: process.env.PLUGIN_AUTO_UPDATE };
    process.env.HOME = join(root, 'home');
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.PLUGIN_AUTO_UPDATE;
    const runtime = join(claudeDir, 'gsd', 'runtime');
    return {
      updater: require(join(claudeDir, 'hooks', 'gsd-auto-update.cjs')),
      state: () => readFile(join(runtime, 'update-state.json'), 'utf8').then(JSON.parse),
      notification: () => readFile(join(runtime, 'update-notification.json'), 'utf8').then(JSON.parse, () => null),
      clearNotification: () => rm(join(runtime, 'update-notification.json'), { force: true }),
      async cleanup() {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        await rm(root, { recursive: true, force: true });
      },
    };
  }

  const check = (updater, latest) => updater.checkForUpdate({
    force: true, install: false, notify: true,
    fetchLatestRelease: async () => latest,
    getCurrentVersion: () => '0.3.0',
  });

  it('keeps the reason, counts the streak, and announces it from the third failure', async () => {
    const ctx = await manualInstall();
    try {
      const failure = { error: 'ECONNREFUSED' };
      assert.equal(await check(ctx.updater, failure), null);
      const first = await ctx.state();
      assert.equal(first.checkFailure.count, 1);
      assert.equal(first.checkFailure.reason, 'ECONNREFUSED');
      assert.ok(first.lastCheck, 'the throttle still applies to a failure');
      assert.equal(await ctx.notification(), null, 'one failure is not news');

      await check(ctx.updater, false); // 403
      const second = await ctx.state();
      assert.equal(second.checkFailure.count, 2);
      assert.equal(second.checkFailure.since, first.checkFailure.since, 'the streak keeps its start');
      assert.match(second.checkFailure.reason, /rate limit/);
      assert.equal(await ctx.notification(), null);

      await check(ctx.updater, failure);
      const note = await ctx.notification();
      assert.equal(note?.kind, 'check_failed', 'the third consecutive failure is announced');
      assert.equal(note.count, 3);
      assert.equal(note.since, first.checkFailure.since);
      assert.equal(note.reason, 'ECONNREFUSED');

      // Then about weekly, not every day.
      const announced = [];
      for (let count = 4; count <= 17; count++) {
        await ctx.clearNotification();
        await check(ctx.updater, failure);
        if (await ctx.notification()) announced.push(count);
      }
      assert.deepEqual(announced, [10, 17]);

      await check(ctx.updater, { version: '0.3.0', tarballUrl: 'https://github.com/x', checksum: null, signature: null });
      assert.equal((await ctx.state()).checkFailure, undefined, 'a successful check ends the streak');
    } finally {
      await ctx.cleanup();
    }
  });

  it('says why in verbose mode, which is what gsd update prints', async () => {
    const ctx = await manualInstall();
    const lines = [];
    const log = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      await ctx.updater.checkForUpdate({ force: true, install: false, verbose: true, fetchLatestRelease: async () => ({ error: 'HTTP 502' }), getCurrentVersion: () => '0.3.0' });
    } finally {
      console.log = log;
      await ctx.cleanup();
    }
    assert.ok(lines.includes('Could not fetch latest release: HTTP 502'), JSON.stringify(lines));
  });
});

// Every kind of notification the updater writes has a reader in each place
// that reads the file: SessionStart prints it, /gsd:doctor reports it. Derived
// from the writer's source, so a new kind cannot be added without both.
describe('every update notification kind is read where the file is read', () => {
  const writer = readFileSync(SOURCE, 'utf8');
  const kinds = [...new Set([...writer.matchAll(/kind: '(\w+)'/g)].map((m) => m[1]))];

  it('premise: the writer has kinds, check_failed among them', () => {
    assert.ok(kinds.includes('updated') && kinds.includes('failed') && kinds.includes('check_failed'), JSON.stringify(kinds));
  });

  it('SessionStart prints each one', () => {
    const init = readFileSync(join(import.meta.dirname, '..', 'hooks', 'gsd-session-init.cjs'), 'utf8');
    assert.deepEqual(kinds.filter((kind) => !init.includes(`notif.kind === '${kind}'`)), []);
  });

  it('/gsd:doctor names each one', () => {
    const doctor = readFileSync(join(import.meta.dirname, '..', 'commands', 'doctor.md'), 'utf8');
    assert.deepEqual(kinds.filter((kind) => !doctor.includes(`\`${kind}\``)), []);
  });
});
