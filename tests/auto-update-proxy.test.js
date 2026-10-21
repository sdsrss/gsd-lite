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
    // Values curl and git accept and Node does not: started with
    // NODE_USE_ENV_PROXY=1, Node exits at startup on each of these, and
    // setGlobalProxyFromEnv throws with the value — credentials and all — in
    // its message.
    ['a proxy with no scheme', { HTTPS_PROXY: 'proxy.corp:3128' }, '26.8.1', withRuntime, 'unusable', false],
    ['a host:port proxy', { HTTPS_PROXY: '127.0.0.1:9' }, '26.8.1', withRuntime, 'unusable', false],
    ['a SOCKS proxy', { HTTPS_PROXY: 'socks5h://127.0.0.1:1080' }, '26.8.1', withRuntime, 'unusable', false],
    ['a proxy URL that does not parse', { HTTPS_PROXY: 'http://alice:pa#ss@proxy.corp:8080' }, '26.8.1', withRuntime, 'unusable', false],
    ['one unusable value among usable ones', { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'proxy.corp:3128' }, '22.21.0', withRuntime, 'unusable', false],
  ]) {
    it(`${label} → ${route}`, () => {
      calls.length = 0;
      assert.equal(mod.envProxyRoute({ env, version, http }), route);
      assert.deepEqual(calls, enabled ? ['runtime'] : [], enabled ? 'the runtime switch is turned on' : 'and nothing global is changed');
    });
  }

  it('a runtime switch that refuses the value counts as unusable rather than throwing', () => {
    const refusing = { setGlobalProxyFromEnv: () => { throw Object.assign(new Error('http://user:secret@proxy:1'), { code: 'ERR_PROXY_INVALID_CONFIG' }); } };
    assert.equal(mod.envProxyRoute({ env: PROXY, version: '26.8.1', http: refusing }), 'unusable');
  });

  it('premise: proxyEnvUsable is exported for session-init', () => {
    assert.equal(typeof mod.proxyEnvUsable, 'function');
    assert.equal(mod.proxyEnvUsable({ HTTPS_PROXY: 'http://127.0.0.1:9' }), true);
    assert.equal(mod.proxyEnvUsable({ HTTPS_PROXY: 'proxy.corp:3128' }), false);
    assert.equal(mod.proxyEnvUsable({}), true, 'nothing set is nothing to refuse');
  });

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

  function probe(env, url) {
    const script = `
      const route = require(${JSON.stringify(SOURCE)}).envProxyRoute();
      fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(5000) })
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

  // http:// is answered by the proxy itself; https:// — what the updater
  // sends — goes through a CONNECT tunnel, which the proxy records and then
  // cannot complete, so the fetch fails after the proxy has seen it.
  for (const [label, extra, url] of [
    ['a child started the way session-init starts the updater (http)', { NODE_USE_ENV_PROXY: '1' }, 'http://gsd-proxy-probe.invalid/probe'],
    ['a child started the way session-init starts the updater (https)', { NODE_USE_ENV_PROXY: '1' }, 'https://gsd-proxy-probe.invalid/probe'],
    ['a process started without it, like `gsd update` (http)', {}, 'http://gsd-proxy-probe.invalid/probe'],
    ['a process started without it, like `gsd update` (https)', {}, 'https://gsd-proxy-probe.invalid/probe'],
  ]) {
    it(label, async () => {
      await withProxy(async (proxyUrl, seen) => {
        const { route, outcome } = await probe(childEnv(proxyUrl, extra), url);
        const proxied = seen.some((line) => line.includes('gsd-proxy-probe.invalid'));
        const claimsProxy = route === 'startup' || route === 'runtime';
        assert.ok(['startup', 'runtime', 'unsupported'].includes(route), `route ${route} on Node ${process.versions.node}`);
        assert.equal(proxied, claimsProxy,
          `Node ${process.versions.node}: route ${route}, but the proxy ${proxied ? 'saw' : 'did not see'} the request (outcome ${outcome}; proxy log ${JSON.stringify(seen)})`);
      });
    });
  }
});

// The route only helps if the two places that reach the network take it
// first. Run each on its own, in a process started the way `gsd update` is,
// against a proxy that sees the CONNECT for GitHub's host and then hangs up.
// Skipped where this Node cannot route at runtime, rather than letting the
// request go out to the real network.
describe('the updater\'s network calls go through the proxy', () => {
  for (const [label, call, host] of [
    ['the release check', 'mod.fetchLatestRelease(null)', 'api.github.com:443'],
    ['the download', "mod.downloadAndInstall('https://github.com/sdsrss/gsd-lite/releases/download/v9.9.9/gsd-lite-9.9.9.tgz')", 'github.com:443'],
  ]) {
    it(label, async (t) => {
      const seen = [];
      const server = createServer();
      server.on('connect', (req, socket) => { seen.push(req.url); socket.destroy(); });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const proxyUrl = `http://127.0.0.1:${server.address().port}`;
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
          if (/^(https?|no|all)_proxy$/i.test(key) || key === 'NODE_USE_ENV_PROXY' || key.startsWith('NODE_TEST')) delete env[key];
        }
        Object.assign(env, { HTTPS_PROXY: proxyUrl, CLAUDE_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'gsd-proxy-wire-')) });
        t.after(() => rm(env.CLAUDE_CONFIG_DIR, { recursive: true, force: true }));
        const script = `
          const mod = require(${JSON.stringify(SOURCE)});
          if (typeof require('node:http').setGlobalProxyFromEnv !== 'function') { console.log('unsupported'); process.exit(0); }
          Promise.resolve(${call}).then(() => { console.log('done'); process.exit(0); }, () => { console.log('done'); process.exit(0); });`;
        const out = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
          let text = '';
          child.stdout.on('data', (d) => { text += d; });
          child.on('error', reject);
          child.on('close', () => resolve(text.trim()));
        });
        if (out === 'unsupported') return void t.skip(`Node ${process.versions.node} has no http.setGlobalProxyFromEnv`);
        assert.equal(out, 'done');
        // At least once, and only for GitHub's host: undici retries a tunnel
        // the proxy hangs up on (seen repeatedly on CI's Node 24.22, once on
        // 26.8), so the count is not the property.
        assert.ok(seen.length > 0 && seen.every((url) => url === host), `the proxy saw ${JSON.stringify(seen)}`);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
});

// `gsd update` with a proxy value Node refuses: the check runs and fails
// with a reason, instead of the refusal escaping with the value in its
// message, which `gsd update` printed.
describe('an unusable proxy setting', () => {
  it('neither throws nor repeats the value', async () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(https?|no|all)_proxy$/i.test(key) || key === 'NODE_USE_ENV_PROXY' || key.startsWith('NODE_TEST')) delete env[key];
    }
    env.HTTPS_PROXY = 'http://alice:pa#ss@proxy.corp:8080';
    const script = `
      globalThis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
      require(${JSON.stringify(SOURCE)}).fetchLatestRelease(null)
        .then((r) => console.log(JSON.stringify(r)), (e) => console.log('THREW ' + e.message));`;
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (d) => { text += d; });
      child.stderr.on('data', (d) => { text += d; });
      child.on('error', reject);
      child.on('close', () => resolve(text.trim()));
    });
    assert.doesNotMatch(out, /alice|pa#ss|THREW/, out);
    assert.match(JSON.parse(out).error, /^ECONNREFUSED \(a proxy is set in the environment that Node cannot use/);
  });
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
    ['unusable', '26.8.1', /a proxy is set in the environment that Node cannot use: it is not an http:\/\/ or https:\/\/ URL/],
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

  const check = (updater, latest, { notify = true } = {}) => updater.checkForUpdate({
    force: true, install: false, notify,
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

  // `gsd update --force` checks without notifying. Its failure counts toward
  // the streak but does not stand for the notice nobody was shown.
  it('a failure nobody was told about does not use up the notice', async () => {
    const ctx = await manualInstall();
    try {
      const failure = { error: 'ECONNREFUSED' };
      await check(ctx.updater, failure);
      await check(ctx.updater, failure);
      await check(ctx.updater, failure, { notify: false });
      assert.equal(await ctx.notification(), null, 'premise: the third failure was the CLI\'s');
      await check(ctx.updater, failure);
      assert.equal((await ctx.notification())?.count, 4, 'the next background check announces it');
    } finally {
      await ctx.cleanup();
    }
  });

  // Within a day of the last check `gsd update` is throttled; it used to say
  // only that, with the failure on record unmentioned.
  it('a throttled gsd update still says the last check failed and why', async () => {
    const ctx = await manualInstall();
    const lines = [];
    const log = console.log;
    try {
      await check(ctx.updater, { error: 'HTTP 502' });
      console.log = (...args) => lines.push(args.join(' '));
      await ctx.updater.checkForUpdate({ install: false, verbose: true, fetchLatestRelease: async () => assert.fail('throttled'), getCurrentVersion: () => '0.3.0' });
    } finally {
      console.log = log;
      await ctx.cleanup();
    }
    assert.ok(lines.some((l) => l.startsWith('Throttled')), JSON.stringify(lines));
    assert.ok(lines.includes('The last check failed (1 in a row): HTTP 502'), JSON.stringify(lines));
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

  // The notice is deleted once shown; the streak stays in update-state.json,
  // and doctor is where it is read after that.
  it('/gsd:doctor reads the failure streak the updater records', () => {
    assert.match(writer, /checkFailure/, 'premise: the updater records checkFailure');
    const doctor = readFileSync(join(import.meta.dirname, '..', 'commands', 'doctor.md'), 'utf8');
    assert.match(doctor, /update-state\.json` has `checkFailure`/);
  });
});
