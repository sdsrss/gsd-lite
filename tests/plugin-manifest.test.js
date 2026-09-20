// What a fresh `/plugin install gsd` actually delivers.
//
// Every other test in this suite drives install.js, which is the npx/manual
// path. The plugin path runs none of it: Claude Code reads the manifests and
// hooks/hooks.json straight out of the plugin cache. That gap is how
// hooks/hooks.json shipped emptied out — the installer tests stayed green while
// a plugin install registered zero hooks, and the README went on promising
// "Automatically registers ... hooks, and auto-update".
//
// These assertions read the shipped files, not the installer.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_REGISTRY } from '../install.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The literal placeholder Claude Code expands to the plugin's install directory.
// Every command and argument the plugin ships must be written against it: a path
// baked in at author time points at the author's machine, and one baked in at
// install time points at a cache directory the next update replaces.
// biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal placeholder, not a template
const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}';
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf-8'));

const pluginJson = readJson('.claude-plugin/plugin.json');
const marketplaceJson = readJson('.claude-plugin/marketplace.json');
const packageJson = readJson('package.json');

/** Resolve the plugin's MCP declaration from wherever it is declared. */
function mcpDeclaration() {
  if (pluginJson.mcpServers && typeof pluginJson.mcpServers === 'object') {
    return { source: '.claude-plugin/plugin.json', servers: pluginJson.mcpServers };
  }
  if (existsSync(join(root, '.mcp.json'))) {
    return { source: '.mcp.json', servers: readJson('.mcp.json').mcpServers };
  }
  return { source: null, servers: null };
}

describe('plugin manifest: hooks reach a plugin install', () => {
  const hooksJson = readJson('hooks/hooks.json');

  it('declares every hook that install.js registers on the npx path', () => {
    // The two install paths must deliver the same behaviour. Deriving the
    // expectation from HOOK_REGISTRY is the point: adding a hook to the
    // installer without adding it here fails right here, instead of silently
    // shipping a plugin install that is missing it.
    for (const { hookType, identifier } of HOOK_REGISTRY) {
      const entries = hooksJson.hooks?.[hookType];
      assert.ok(Array.isArray(entries) && entries.length > 0,
        `hooks/hooks.json declares no ${hookType} entry, so a plugin install gets no ${identifier}`);
      const entry = entries.find(e => e.hooks?.some(h => h.command?.includes(identifier)));
      assert.ok(entry, `hooks/hooks.json has no ${hookType} command running ${identifier}`);
    }
  });

  it('agrees with install.js on matcher and timeout for every hook', () => {
    for (const { hookType, identifier, matcher, timeout } of HOOK_REGISTRY) {
      const entry = hooksJson.hooks[hookType].find(e =>
        e.hooks.some(h => h.command.includes(identifier)));
      assert.equal(entry.matcher, matcher,
        `${hookType}/${identifier} matcher differs between hooks.json and install.js`);
      const hook = entry.hooks.find(h => h.command.includes(identifier));
      assert.equal(hook.timeout, timeout,
        `${hookType}/${identifier} timeout differs between hooks.json and install.js`);
    }
  });

  it('roots every hook command at the plugin-root placeholder and points at a real file', () => {
    for (const entry of Object.values(hooksJson.hooks).flat()) {
      for (const hook of entry.hooks) {
        assert.ok(hook.command.includes(PLUGIN_ROOT),
          `hook command is not relocatable: ${hook.command}`);
        const rel = hook.command.split(`${PLUGIN_ROOT}/`)[1]?.replace(/["'].*$/, '');
        assert.ok(rel, `cannot extract a path from: ${hook.command}`);
        assert.ok(existsSync(join(root, rel)), `hook script does not exist: ${rel}`);
      }
    }
  });
});

describe('plugin manifest: MCP server', () => {
  it('keeps the declaration out of a repo-root .mcp.json', () => {
    // A .mcp.json at the repo root is not only the plugin's MCP manifest — it is
    // also project-scope MCP config for anyone whose working directory is this
    // repo, and ${CLAUDE_PLUGIN_ROOT} is not defined there. Claude Code then
    // reports `[gsd] Missing environment variables: CLAUDE_PLUGIN_ROOT` and the
    // project entry shadows the user's working install, so the maintainers are
    // the one group guaranteed never to see their own MCP server work.
    assert.ok(!existsSync(join(root, '.mcp.json')),
      'declare mcpServers inline in .claude-plugin/plugin.json instead');
  });

  it('declares the gsd server with a plugin-root entry point that exists', () => {
    const { source, servers } = mcpDeclaration();
    assert.ok(source, 'no MCP declaration found in plugin.json or .mcp.json');
    assert.ok(servers?.gsd, `${source} declares no "gsd" MCP server`);
    const arg = servers.gsd.args?.find(a => a.includes(PLUGIN_ROOT));
    assert.ok(arg, `${source} does not root the gsd server at the plugin-root placeholder`);
    const rel = arg.replace(`${PLUGIN_ROOT}/`, '');
    assert.ok(existsSync(join(root, rel)), `MCP entry point does not exist: ${rel}`);
  });
});

describe('plugin manifest: advertised inventory matches the tree', () => {
  const countMd = (dir) => readdirSync(join(root, dir)).filter(f => f.endsWith('.md')).length;

  it('marketplace description states the real command, agent and workflow counts', () => {
    // The marketplace blurb is what /plugin shows before anyone installs.
    const description = marketplaceJson.plugins.find(p => p.name === 'gsd').description;
    for (const [label, dir] of [['commands', 'commands'], ['agents', 'agents'], ['workflows', 'workflows']]) {
      const actual = countMd(dir);
      const claimed = Number(description.match(new RegExp(`(\\d+) ${label}`))?.[1]);
      assert.equal(claimed, actual,
        `marketplace.json claims ${claimed} ${label}, tree has ${actual}`);
    }
  });

  it('README states the real MCP tool count', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf-8');
    const server = readFileSync(join(root, 'src/server.js'), 'utf-8');
    const actual = server.match(/^ {4}name: '/gm).length;
    const claimed = Number(readme.match(/### MCP Server \((\d+) Tools\)/)?.[1]);
    assert.equal(claimed, actual, `README claims ${claimed} MCP tools, server.js defines ${actual}`);
  });

  it('names only test files that exist, in text that ships to users', () => {
    // hooks/hooks.json is copied into the plugin cache verbatim, so a wrong
    // filename in its description reaches users, not just contributors. Both it
    // and install.js pointed at tests/plugin-hooks.test.js, which never existed.
    for (const file of ['hooks/hooks.json', 'install.js']) {
      const source = readFileSync(join(root, file), 'utf-8');
      for (const [, named] of source.matchAll(/(tests\/[\w.-]+\.test\.js)/g)) {
        assert.ok(existsSync(join(root, named)), `${file} names ${named}, which does not exist`);
      }
    }
  });

  it('keeps package.json, plugin.json and marketplace.json on one version', () => {
    assert.equal(pluginJson.version, packageJson.version);
    for (const entry of marketplaceJson.plugins) {
      assert.equal(entry.version, packageJson.version);
    }
  });

  it('ships the version the CHANGELOG says it is shipping', () => {
    // The three manifests agreeing with each other says nothing about whether
    // the bump happened: they agree at the old version too. Tie them to the
    // CHANGELOG heading, which is written by hand, so a forgotten
    // `npm version` fails here instead of shipping green.
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf-8');
    const top = changelog.match(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/m)?.[1];
    assert.ok(top, 'CHANGELOG has no versioned heading');
    assert.equal(packageJson.version, top,
      `package.json is ${packageJson.version} but the CHANGELOG heads ${top} — run npm version`);
  });
});
