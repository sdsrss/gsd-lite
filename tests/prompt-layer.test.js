// Prompt-layer gates: the shipped commands/agents must say what the code does.
//
// Every defect these cover came from the 2026-10-17 prompt audit
// (tasks/specs/prompt-audit-2026-10-17.md): a prompt naming a file nothing
// writes, a threshold the code does not use, a payload field the orchestrator
// never sends, a command Claude Code does not have. The prompt is the layer the
// model routes through, so each of these is a behaviour defect even though no
// code is wrong.
//
// Where the truth lives in code, the expected value is READ from that code —
// the notification file and its kinds from the hook, the lock threshold from
// src/utils.js, the reviewer payload from a real orchestrator-resume call — so
// the next change to the code fails here instead of drifting silently.
//
// Some gates below are token checks, and say so: when the defect IS a wrong
// token (a tool name from another harness, a pressure tag), the token is the
// property. They do not prove the surrounding prose is right.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { LOCK_STALE_MS } from '../src/utils.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

// Walk the directories rather than asking git: an untracked prompt file is
// exactly the one most likely to carry a regression.
function mdFiles(dir) {
  return readdirSync(join(repoRoot, dir)).filter((f) => f.endsWith('.md')).map((f) => `${dir}/${f}`);
}
const PROMPT_DIRS = ['commands', 'agents', 'workflows', 'references'];
const promptFiles = PROMPT_DIRS.flatMap(mdFiles);

// The text between a heading and the next heading of the same depth, or the
// closing tag of the block the heading sits in, whichever comes first.
function section(src, heading) {
  const start = src.indexOf(heading);
  assert.ok(start !== -1, `premise: ${heading} not found`);
  const depth = heading.match(/^#+/)[0];
  const rest = src.slice(start + heading.length);
  const next = rest.search(new RegExp(`^(?:${depth} |</)`, 'm'));
  return next === -1 ? rest : rest.slice(0, next);
}

function tagBlock(src, tag) {
  const open = src.indexOf(`<${tag}>`);
  const close = src.indexOf(`</${tag}>`);
  assert.ok(open !== -1 && close > open, `premise: <${tag}> block not found`);
  return src.slice(open, close);
}

describe('prompt layer — the corpus', () => {
  it('finds the shipped prompt files', () => {
    // Vacuity guard for every gate below that loops over promptFiles.
    assert.ok(promptFiles.length >= 20, `expected the shipped prompt layer, found ${promptFiles.length} files`);
    for (const dir of ['commands', 'agents']) {
      assert.ok(mdFiles(dir).length >= 4, `${dir}/ looks empty`);
    }
  });
});

describe('prompt layer — doctor checks what the code actually does', () => {
  const doctor = read('commands/doctor.md');
  const autoUpdate = read('hooks/gsd-auto-update.cjs');

  it('reads the update notification file the auto-update hook writes, by every kind it writes', () => {
    const file = autoUpdate.match(/NOTIFICATION_FILE = path\.join\(stateDir, '([^']+)'\)/)?.[1];
    assert.ok(file, 'premise: NOTIFICATION_FILE not found in hooks/gsd-auto-update.cjs');
    assert.match(autoUpdate, /const stateDir = path\.join\(runtimeDir, 'runtime'\)/,
      'premise: the notification no longer lives under runtime/ — update this gate');
    assert.ok(doctor.includes(`runtime/${file}`),
      `doctor.md does not read runtime/${file}, the only update marker any code writes`);

    const kinds = new Set([...autoUpdate.matchAll(/kind:\s*'(\w+)'/g)].map((m) => m[1]));
    assert.ok(kinds.size >= 3, `premise: expected the hook's notification kinds, found ${[...kinds]}`);
    const step = section(doctor, '## STEP 5');
    for (const kind of kinds) {
      assert.ok(step.includes(`\`${kind}\``), `doctor.md STEP 5 does not report kind \`${kind}\``);
    }
  });

  it('names no ~/.claude/gsd/ file that no code reads or writes', () => {
    // The class behind `.update-pending`: a marker documented in the prompt and
    // produced by nothing, so the check it describes can never fire.
    const codeFiles = [
      ...readdirSync(join(repoRoot, 'hooks')).filter((f) => f.endsWith('.cjs')).map((f) => `hooks/${f}`),
      ...readdirSync(join(repoRoot, 'hooks', 'lib')).filter((f) => f.endsWith('.cjs')).map((f) => `hooks/lib/${f}`),
      'install.js', 'uninstall.js', 'cli.js',
      ...readdirSync(join(repoRoot, 'src'), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`),
    ];
    const code = codeFiles.map(read).join('\n');
    const named = [...doctor.matchAll(/~\/\.claude\/gsd\/([\w./-]+)/g)].map((m) => basename(m[1]));
    assert.ok(named.length >= 2, `premise: doctor.md names only ${named.length} runtime files`);
    const orphans = named.filter((name) => !code.includes(`'${name}'`));
    assert.deepEqual(orphans, [], `doctor.md checks files no code reads or writes: ${orphans.join(', ')}`);
  });

  it('compares the source version only inside the gsd-lite repository', () => {
    // In any other project the root package.json is that project's version: a
    // v0.112.0 app was reported as "server v0.13.0 but source is v0.112.0".
    const pkgName = JSON.parse(read('package.json')).name;
    const bullets = doctor.split(/\n(?=\s*[-*]\s)/)
      .filter((b) => /`package\.json`/.test(b) && /project root/i.test(b));
    assert.ok(bullets.length >= 1, 'premise: doctor.md no longer reads package.json from the project root');
    for (const b of bullets) {
      assert.ok(b.includes('`name`') && b.includes(pkgName),
        `doctor.md reads the current project's package.json as the gsd source version without checking it is ${pkgName}:\n  ${b.trim()}`);
    }
  });

  it("records the health tool's own version-drift warning", () => {
    const server = read('src/server.js');
    const health = server.slice(server.indexOf("case 'health':"), server.indexOf("case 'state-init':"));
    assert.match(health, /\bwarning:/, 'premise: the health response no longer carries `warning`');
    assert.match(section(doctor, '## STEP 5'), /`warning`/, 'doctor.md ignores the health response `warning`');
  });

  it('calls a lock stale at the age the server does', () => {
    // A 5-minute threshold reported a lock the server had already declared
    // abandoned as "likely active operation" for the 4m50s in between.
    const units = { ms: 1, s: 1000, sec: 1000, second: 1000, seconds: 1000, min: 60_000, minute: 60_000, minutes: 60_000 };
    const step = section(doctor, '## STEP 4');
    const durations = [...step.matchAll(/(\d+)\s*(ms|seconds?|sec|s|minutes?|min)\b/g)]
      .map((m) => Number(m[1]) * units[m[2]]);
    assert.ok(durations.length >= 1, 'premise: doctor.md STEP 4 names no lock age');
    assert.deepEqual([...new Set(durations)], [LOCK_STALE_MS],
      `doctor.md STEP 4 uses ${durations.join('/')} ms; withFileLock breaks a lock older than LOCK_STALE_MS = ${LOCK_STALE_MS} ms`);
  });
});

describe('prompt layer — upgrade instructions use commands Claude Code has', () => {
  // `/plugin update` is not an in-session subcommand. The documented paths
  // (code.claude.com/docs/en/discover-plugins, "Update plugins now") are the
  // /plugin Installed tab → Update now, or `claude plugin update <plugin>@<marketplace>`.
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
  const pluginId = `${marketplace.plugins[0].name}@${marketplace.name}`;
  const userText = [...promptFiles, 'README.md'];

  it('no shipped text tells the user to run /plugin update', () => {
    const offenders = [];
    for (const file of userText) {
      read(file).split('\n').forEach((line, i) => {
        if (/(^|[^\w])\/plugin update\b/.test(line)) offenders.push(`${file}:${i + 1} → ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], `not a Claude Code command:\n  ${offenders.join('\n  ')}`);
  });

  for (const file of ['README.md', 'commands/doctor.md']) {
    it(`${file} gives both documented update paths for ${pluginId}`, () => {
      const src = read(file);
      assert.ok(src.includes(`claude plugin update ${pluginId}`), `${file} lacks \`claude plugin update ${pluginId}\``);
      assert.match(src, /Installed[\s\S]{0,80}Update now/, `${file} lacks the /plugin → Installed → Update now path`);
    });
  }
});

describe('prompt layer — commands', () => {
  it('stop writes state only through state-update', () => {
    // "先写 .tmp 再 rename" told the orchestrator to do the server's job by
    // hand, outside its lock and its schema check.
    const rules = tagBlock(read('commands/stop.md'), 'rules');
    assert.match(rules, /`state-update`/, 'stop.md rules do not route the write through state-update');
    assert.doesNotMatch(rules, /\.tmp|rename/, 'stop.md tells the orchestrator to do the atomic write itself');
  });

  it('names no tool another harness has and Claude Code does not (token check)', () => {
    // `codebase-retrieval` is another harness's tool. Under Claude Code the
    // instruction names nothing callable, and the step is skipped or guessed.
    const offenders = promptFiles.filter((f) => read(f).includes('codebase-retrieval'));
    assert.deepEqual(offenders, []);
  });

  it('no command wraps its rules in a pressure tag (token check)', () => {
    // The orchestration rules have reasons; the tag only raised the volume.
    const offenders = mdFiles('commands').filter((f) => read(f).includes('EXTREMELY-IMPORTANT'));
    assert.deepEqual(offenders, [], 'state the rule and its reason instead of raising the volume');
  });
});
