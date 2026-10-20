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
// Where the fix is an instruction, the gate asserts the instruction SENTENCE
// (INSTRUCTIONS below), not a word from it: a word survives its own negation —
// "不要放进 accepted_tasks" carries every token of the rule it reverses — and a
// sentence does not. What a sentence check still cannot see is a contradicting
// sentence added somewhere else in the file. Some gates are plain token checks
// and say so: when the defect IS a wrong token (a tool name from another
// harness, a pressure tag), the token is the property.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { LOCK_STALE_MS } from '../src/utils.js';
import { init, update } from '../src/tools/state/index.js';
import { resumeWorkflow } from '../src/tools/orchestrator/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

// Walk the directories rather than asking git: an untracked prompt file is
// exactly the one most likely to carry a regression.
function mdFiles(dir) {
  return readdirSync(join(repoRoot, dir)).filter((f) => f.endsWith('.md')).map((f) => `${dir}/${f}`);
}
const PROMPT_DIRS = ['commands', 'agents', 'workflows', 'references'];
const promptFiles = PROMPT_DIRS.flatMap(mdFiles);

function frontmatterDescription(src) {
  const fm = src.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  return fm.match(/^description:\s*(.*)$/m)?.[1] ?? '';
}

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
  // The hooks print upgrade instructions too: the SessionStart banner and
  // `gsd update`'s plugin-mode line are the ones users see most.
  const hookCode = ['hooks', 'hooks/lib'].flatMap((dir) =>
    readdirSync(join(repoRoot, dir)).filter((f) => f.endsWith('.cjs')).map((f) => `${dir}/${f}`));
  const userText = [...promptFiles, 'README.md', ...hookCode];

  it('no shipped text tells the user to run /plugin update', () => {
    const offenders = [];
    for (const file of userText) {
      read(file).split('\n').forEach((line, i) => {
        if (/(^|[^\w])\/plugin update\b/.test(line)) offenders.push(`${file}:${i + 1} → ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], `not a Claude Code command:\n  ${offenders.join('\n  ')}`);
  });

  it('the hooks print the plugin id the marketplace defines', () => {
    // The hooks hardcode it; derive it here so a renamed marketplace fails.
    assert.ok(read('hooks/gsd-session-init.cjs').includes(`claude plugin update ${pluginId}`), 'session-init banner names another plugin id');
    assert.match(read('hooks/gsd-session-init.cjs'), /Installed → gsd → Update now/, 'session-init banner lacks the in-session path');
    assert.ok(read('hooks/gsd-auto-update.cjs').split(`claude plugin update ${pluginId}`).length - 1 >= 2,
      'gsd update should give the shell command on both plugin-mode lines');
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
    const stop = read('commands/stop.md');
    assert.match(tagBlock(stop, 'rules'), /`state-update`/, 'stop.md rules do not route the write through state-update');
    // The whole file: a .tmp + rename instruction in STEP 2 is the same defect.
    assert.doesNotMatch(stop, /\.tmp|rename/, 'stop.md tells the orchestrator to do the atomic write itself');
  });

  it('names no tool another harness has and Claude Code does not (token check)', () => {
    // `codebase-retrieval` is another harness's tool. Under Claude Code the
    // instruction names nothing callable, and the step is skipped or guessed.
    const offenders = promptFiles.filter((f) => read(f).includes('codebase-retrieval'));
    assert.deepEqual(offenders, []);
  });

  it('command descriptions state intent instead of enumerating trigger phrases', () => {
    // A description listing "Use when: (1)…(5) '帮我做…'" routes ordinary
    // implementation requests to a /gsd command.
    for (const file of mdFiles('commands')) {
      const description = frontmatterDescription(read(file));
      assert.ok(description.length > 0, `premise: ${file} has no description`);
      assert.doesNotMatch(description, /Use when|Triggers?:|\(\d\)|用户说|帮我|let'?s build/i, `${file} description enumerates triggers: ${description}`);
    }
  });

  it('no command wraps its rules in a pressure tag (token check)', () => {
    // The orchestration rules have reasons; the tag only raised the volume.
    const offenders = mdFiles('commands').filter((f) => read(f).includes('EXTREMELY-IMPORTANT'));
    assert.deepEqual(offenders, [], 'state the rule and its reason instead of raising the volume');
  });
});

describe('prompt layer — agents', () => {
  const agents = mdFiles('agents');

  it('each agent description says GSD-Lite dispatches it and what it is not for', () => {
    // Generic descriptions ("Systematic debugging with root cause analysis")
    // route a user's ordinary debugging, review or research request here.
    for (const file of agents) {
      const description = frontmatterDescription(read(file));
      assert.match(description, /GSD-Lite/, `${file} description does not say it belongs to GSD-Lite: ${description}`);
      assert.match(description, /dispatched by the GSD orchestrator/, `${file} description does not say who dispatches it`);
      assert.match(description, /\bNot for\b/, `${file} description does not say what it is not for: ${description}`);
    }
    // The researcher has two dispatch paths, and a description naming one of
    // them under-describes when it runs.
    assert.match(read('src/tools/orchestrator/resume.js'), /action: 'dispatch_researcher'/, 'premise: resume no longer re-dispatches the researcher');
    assert.match(frontmatterDescription(read('agents/researcher.md')), /before planning or when stored research expires/,
      'researcher description names only the planning dispatch, not the refresh one');
  });

  it('no agent wraps a rule in a pressure block or states it as an all-caps iron law', () => {
    for (const file of agents) {
      const src = read(file);
      assert.doesNotMatch(src, /EXTREMELY-IMPORTANT/, `${file} raises the volume instead of giving the reason`);
      assert.doesNotMatch(src, /\bNO [A-Z]+(?: [A-Z]+)* WITHOUT\b/, `${file} carries an all-caps iron law`);
      assert.doesNotMatch(src, /来自 Superpowers/, `${file} cites a disabled plugin as the authority for a rule`);
    }
  });

  it('a workflow that says it matches an agent quotes the agent, and none carries an all-caps law', () => {
    // tdd-cycle.md and debugging.md headed their rule "铁律 (与 executor/debugger
    // 一致)" over an all-caps line the agents no longer carry — every executor
    // dispatch loads tdd-cycle.md, so the claim of agreement was read as fact.
    for (const file of promptFiles) {
      assert.doesNotMatch(read(file), /\bNO [A-Z]+(?: [A-Z]+)* WITHOUT\b/, `${file} carries an all-caps iron law`);
    }
    for (const [workflow, agent, block] of [
      ['workflows/tdd-cycle.md', 'agents/executor.md', 'testing_rules'],
      ['workflows/debugging.md', 'agents/debugger.md', 'principles'],
    ]) {
      const src = read(workflow);
      const header = `## 规则 (与 ${basename(agent, '.md')} 的 \`${block}\` 一致)`;
      assert.ok(src.includes(header), `${workflow} no longer names the agent block it claims to match`);
      const firstSentence = section(src, header).trim().split('。')[0];
      assert.ok(firstSentence.length > 10 && tagBlock(read(agent), block).includes(`${firstSentence}。`),
        `${workflow} claims to match ${agent} <${block}> but its rule is not in it:\n  ${firstSentence}`);
    }
    assert.doesNotMatch(read('references/anti-rationalization-full.md'), /Agent 内联版本为精简摘要/,
      'the reference still says the agents carry a red-flag summary');
  });

  it('the executor gives the reason for test-first and for fresh evidence', () => {
    const rules = tagBlock(read('agents/executor.md'), 'testing_rules');
    assert.match(rules, /后写的测试/, 'test-first has lost its reason');
    assert.match(rules, /本次运行/, 'the completion rule no longer asks for output from this run');
    assert.match(section(rules, '## TDD 例外'), /checkpoint commit/, 'the TDD exemption list is gone');
  });

  it('a TDD exemption does not lower the review level', () => {
    // The exemption list puts migrations and CI/CD config next to CSS and docs.
    // Skipping the failing test is fine; skipping the review is not.
    const exemptions = section(read('agents/executor.md'), '## TDD 例外');
    assert.match(exemptions, /迁移/, 'premise: migrations are no longer exempt');
    assert.match(exemptions, /免 TDD 不降低审查级别/, 'executor TDD exemptions do not say the review level stands');
    assert.doesNotMatch(exemptions, /review_required[^。\n]*false/, 'the exemption offers review_required: false, which skips review below L3');
  });

  it('the reviewer role keeps the rule the pressure block repeated', () => {
    const role = tagBlock(read('agents/reviewer.md'), 'role');
    assert.match(role, /自己运行测试/, 'reviewer <role> no longer tells it to run the tests itself');
    assert.match(role, /executor 的报告/, "reviewer <role> no longer says the executor's report is not evidence");
    assert.match(role, /命令输出或代码位置/, 'reviewer <role> no longer asks for evidence with each conclusion');
  });

  it('the debugger states its root-cause rule once, with its reason', () => {
    // It was written four times — iron law, red flags, a HARD-GATE, the phase
    // heading — and never said why.
    const src = read('agents/debugger.md');
    assert.doesNotMatch(src, /root-cause-before-fix/, 'the HARD-GATE restating the rule is back');
    const principles = tagBlock(src, 'principles');
    assert.match(principles, /`fix_direction`/, 'the rule no longer names what it gates');
    assert.match(principles, /重试/, 'the rule no longer says what an unfounded direction costs');
    assert.match(principles, /`architecture_concern: true`/, 'the 2+ failed directions case is gone');
  });

  it('the debugger says one thing about three failed directions, and it is what the code does', () => {
    // Phase 4 and uncertainty_handling say: third failure → failed AND
    // architecture_concern: true, and the server then fails the whole phase.
    // The new principles paragraph first said "task 随之失败", and the result
    // rules said the orchestrator only "应考虑" failing the phase.
    assert.match(read('src/tools/orchestrator/debugger.js'), /const phaseFailed = result\.architecture_concern === true;/,
      'premise: architecture_concern no longer decides phase failure');
    const src = read('agents/debugger.md');
    const principles = tagBlock(src, 'principles');
    assert.ok(principles.includes('第 3 次仍无效就必须返回 `failed` 并标记 `architecture_concern: true`，整个 phase 随之失败'),
      'the principles paragraph disagrees with Phase 4 about the third failed direction');
    assert.match(tagBlock(src, 'four_phases'), /3 次修复方向均被 executor 验证无效 → 停止。标记 architecture_concern: true/,
      'premise: Phase 4 no longer states the third-failure rule');
    for (const file of ['agents/debugger.md', 'workflows/debugging.md']) {
      assert.doesNotMatch(read(file), /task 随之失败|应考虑标记 phase failed|只让 task 失败/, `${file}: a sentence contradicting the third-failure rule is back`);
    }
  });

  it('the debugger, which has no Edit tool, is not told to add logging', () => {
    const src = read('agents/debugger.md');
    const tools = src.match(/^tools:\s*(.*)$/m)?.[1] ?? '';
    assert.ok(tools.length > 0 && !/\bEdit\b|\bWrite\b/.test(tools), `premise: debugger tools are ${tools}`);
    assert.doesNotMatch(src, /添加日志/, 'debugger.md asks for an edit its tools and its role both rule out');
  });

  it('the reviewer takes the level from the task and reports it in the vocabulary the server accepts', () => {
    const schema = read('src/schema.js');
    const accepted = schema.match(/if \(!\[([^\]]+)\]\.includes\(r\.review_level\)\)/)?.[1];
    assert.ok(accepted, 'premise: review_level validation not found in src/schema.js');
    const levels = [...accepted.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    const reviewer = read('agents/reviewer.md');
    const contract = reviewer.match(/"review_level":\s*"([^"]+)"/)?.[1];
    assert.ok(contract, 'premise: reviewer result contract has no review_level');
    assert.deepEqual(contract.split('|').map((s) => s.trim()).sort(), levels);

    // The level is decided at planning time. A second rule here was the
    // defect: it omitted L3 and contradicted the file's own L3 section.
    assert.doesNotMatch(reviewer, /→\s*L[0-3]\b/, 'reviewer.md maps work types to levels again');
    const strategy = tagBlock(reviewer, 'review_strategy');
    assert.match(strategy, /`level`/, 'review_strategy does not take the level from the task');
    assert.match(strategy, /`review_level`/, 'review_strategy does not say where the level is reported');
  });

  it('the reviewer lists a passing L3 task in accepted_tasks, which is what the server holds', () => {
    // handleReviewerResult holds an L3 task for human confirmation only when it
    // arrives in accepted_tasks (src/tools/orchestrator/reviewer.js). A reviewer
    // told the task "enters awaiting_user instead of accepted" may leave it out.
    // That does not get it past the hold — the level-driven gate re-raises it at
    // the next phase review — but it costs a whole extra review round.
    assert.match(read('src/tools/orchestrator/reviewer.js'),
      /result\.accepted_tasks \|\| \[\]\)\.filter\(\(taskId\) => \{[\s\S]{0,200}task\.level === 'L3'/,
      'premise: the L3 hold no longer filters accepted_tasks');
    const l3 = tagBlock(read('agents/reviewer.md'), 'review_strategy').split('\n').filter((l) => /L3/.test(l)).join('\n');
    for (const field of ['accepted_tasks', 'requires_human_confirmation', 'security_implications', 'OWASP']) {
      assert.ok(l3.includes(field), `reviewer L3 guidance does not mention ${field}`);
    }
    // The sentence, not the words: "不要放进 accepted_tasks" carries the same
    // four tokens and was green under the token-only version of this test.
    assert.ok(l3.includes('通过审查的 L3 task 照常放进 `accepted_tasks`：服务端据此把它转入 awaiting_user 等用户确认'),
      'reviewer L3 guidance no longer tells it to list a passing L3 task in accepted_tasks');
    // A phase batch can carry an L3 task too (the omitted-task path above).
    assert.ok(l3.includes('阶段批量里出现 L3 task 时也一样'), 'reviewer L3 guidance reads as task-scope only');
    assert.doesNotMatch(l3, /不放进去它就停在 checkpointed。/, 'the false "never reaches the hold" claim is back');
  });

  describe('the reviewer input protocol matches the payload orchestrator-resume sends', () => {
    // The protocol described `review_targets` with levels L1/L2 and a
    // `task_spec` path. The real payload has `review_scope`, `phase_id`,
    // `current_review`, and `review_target` (singular) for a task review; no
    // `task_spec` at all. Read the keys off a real dispatch, not a copy.
    const tempDirs = [];
    const payloads = {};
    // One project per mode, each driven the way the orchestrator drives it:
    // a task checkpointed, then the review mode the executor result would set.
    async function dispatchReviewer(currentReview, workflowMode) {
      const dir = await mkdtemp(join(tmpdir(), 'gsd-prompt-layer-'));
      tempDirs.push(dir);
      await init({ project: 'prompt-layer', phases: [{ name: 'Core', tasks: [{ index: 1, name: 'Task A' }] }], basePath: dir });
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'running' }] }] }, basePath: dir });
      await update({ updates: { phases: [{ id: 1, todo: [{ id: '1.1', lifecycle: 'checkpointed', checkpoint_commit: 'abc1234' }] }] }, basePath: dir });
      await update({ updates: { workflow_mode: workflowMode, current_review: currentReview }, basePath: dir });
      return resumeWorkflow({ basePath: dir });
    }
    before(async () => {
      payloads.task = await dispatchReviewer({ scope: 'task', scope_id: '1.1', stage: 'spec' }, 'reviewing_task');
      payloads.phase = await dispatchReviewer({ scope: 'phase', scope_id: 1 }, 'reviewing_phase');
    });
    after(() => Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }))));

    // success / action / workflow_mode are the loop's routing fields, and
    // `summary` is the display block resume attaches to every successful
    // response (commands/resume.md STEP 1) — all read by the orchestrator.
    // Everything else is what the reviewer receives.
    const ROUTING = new Set(['success', 'action', 'workflow_mode', 'summary']);

    it('names every field the payload carries and none it does not', () => {
      assert.equal(payloads.task.review_scope, 'task', `premise: task fixture returned ${JSON.stringify(payloads.task)}`);
      assert.equal(payloads.phase.review_scope, 'phase', `premise: phase fixture returned ${JSON.stringify(payloads.phase)}`);
      const sent = new Set();
      for (const p of Object.values(payloads)) {
        for (const k of Object.keys(p)) if (!ROUTING.has(k)) sent.add(k);
        for (const k of Object.keys(p.current_review || {})) sent.add(k);
        for (const t of [p.review_target, ...(p.review_targets || [])].filter(Boolean)) {
          for (const k of Object.keys(t)) sent.add(k);
        }
      }
      assert.ok(sent.has('review_target') && sent.has('review_targets'), `premise: payload keys were ${[...sent]}`);

      const protocol = tagBlock(read('agents/reviewer.md'), 'context_protocol');
      const named = new Set([...protocol.matchAll(/^\s*- `(\w+)`/gm)].map((m) => m[1]));
      const missing = [...sent].filter((k) => !named.has(k));
      const invented = [...named].filter((k) => !sent.has(k));
      assert.deepEqual(missing, [], 'reviewer context_protocol omits fields the payload carries');
      assert.deepEqual(invented, [], 'reviewer context_protocol describes fields the payload never carries');
    });

    it('says where the task spec is, since the payload does not carry it', () => {
      const protocol = tagBlock(read('agents/reviewer.md'), 'context_protocol');
      assert.match(protocol, /\.gsd\/phases\/phase-<phase_id>\.md/, 'reviewer has no way to find the task spec');
    });
  });

  it('every reviewer dispatch forwards the response instead of gathering checkpoint info from state', () => {
    // The response's targets are what taskRefsForAgent constrained. resume.md's
    // phase path said "收集该 phase 中所有 L1 task 的 checkpoint 信息" and its task
    // path "加载对应 task 的 checkpoint 信息" — both an instruction to read the
    // raw values. untrusted-checkout.test.js's routing gate keys on the field
    // NAMES and so could not see a bullet that only said "checkpoint 信息".
    const resume = read('commands/resume.md');
    for (const [mode, field] of [['reviewing_task', 'review_target'], ['reviewing_phase', 'review_targets']]) {
      const body = section(resume, `### \`${mode}\``);
      assert.ok(body.includes(`\`${field}\` 原样转发`), `resume.md ${mode} does not forward ${field} from the response`);
      // The rest of what reviewer.md's context_protocol says it receives.
      assert.ok(body.includes('响应里的 `review_scope` / `phase_id` / `current_review` 一并转发'),
        `resume.md ${mode} does not forward review_scope / phase_id / current_review, which the reviewer protocol expects`);
    }
    const gathering = [];
    for (const file of [...mdFiles('commands'), ...mdFiles('workflows')]) {
      read(file).split('\n').forEach((line, i) => {
        // "不要" exempts a line only when it negates the read itself: "不要忘了先从
        // state 读取 checkpoint_commit" is an instruction to read. 读 counts
        // as well as 收集/加载, from state or not: with 读取 off this list,
        // "读取该 task 的 `checkpoint_commit`…一并传给 reviewer" passed (third
        // pre-tag review). A word list on one line: other verbs (获取, 取出), a
        // verb after `checkpoint` or across a line break, and Checkpoint
        // capitalised all pass, and a negation other than 不要 still reads as
        // gathering (fourth pre-tag review).
        const gathers = /(收集|加载|读)[^\n]*checkpoint/.test(line);
        const negated = /不要(自己)?(从 ?state ?里?)?(读|收集|加载)/.test(line);
        if (gathers && !negated) gathering.push(`${file}:${i + 1} → ${line.trim()}`);
      });
    }
    assert.deepEqual(gathering, [], `these tell the orchestrator to gather checkpoint info itself:\n  ${gathering.join('\n  ')}`);
    const row = read('workflows/execution-flow.md').split('\n').find((l) => l.startsWith('| `dispatch_reviewer`'));
    assert.ok(row?.includes('`review_target`') && row.includes('`review_targets`'),
      'the action table dispatches the reviewer without saying what to forward');
  });
});

describe('prompt layer — planning research stays out of state', () => {
  // Recording planning research in state makes the expiry refresh reachable,
  // and that refresh cannot end yet: applyResearchRefresh leaves an accepted
  // phase holding a needs_revalidation task, validateState rejects the state,
  // and every resume re-dispatches the researcher (fourth pre-tag review).
  // Until the refresh is redesigned, planning hands nothing to the handler and
  // the researcher writes .gsd/research/ itself, as in 0.15. Remove this
  // together with that redesign.
  it('STEP 5–10 do not hand planning research to orchestrator-handle-researcher-result', () => {
    const flow = read('workflows/execution-flow.md');
    const planning = flow.slice(flow.indexOf('## STEP 5'), flow.indexOf('## STEP 11'));
    assert.ok(planning.includes('## STEP 10') && !planning.includes('## STEP 11'), 'premise: the slice is not STEP 5–10');
    assert.doesNotMatch(planning, /orchestrator-handle-researcher-result/,
      'planning hands research to the handler, which records it in state and makes the refresh reachable');
  });
});

describe('prompt layer — planning-time level rules', () => {
  // Migrations, CI/CD and deployment config were L0-shaped ("config") or
  // absent. They are at least L2; anything touching production is L3, the
  // level the server holds for human confirmation. L2 and L3 are never
  // reclassified downward (reclassifyReviewLevel), so the planned level is the
  // one that holds. Token checks: they confirm the categories are named at the
  // right level, not that the prose is good.
  const cases = [
    ['workflows/execution-flow.md', (src) => section(src, '## STEP 7').split('\n').filter((l) => /\*\*L[0-3]\*\*/.test(l))],
    ['references/review-classification.md', (src) => section(src, '## 静态分类').split('\n').filter((l) => /^\| L[0-3] /.test(l))],
    ['README.md', (src) => section(src, '### Review Levels').split('\n').filter((l) => /^\| L[0-3] /.test(l))],
  ];
  for (const [file, levelLines] of cases) {
    it(`${file} puts migrations, CI/CD and deployment at L2 or above, production at L3`, () => {
      const lines = levelLines(read(file));
      assert.equal(lines.length, 4, `premise: expected four level lines in ${file}, found ${lines.length}`);
      // By the line's own level marker: an L0 line may well say "see L2".
      const at = (level) => lines.find((l) => l.includes(`**${level}**`) || l.startsWith(`| ${level} `)) ?? '';
      for (const word of [/迁移|migration/i, /CI\/CD/, /部署|deploy/i]) {
        assert.match(at('L2'), word, `${file} L2 does not name ${word}`);
      }
      assert.match(at('L3'), /生产|production/i, `${file} L3 does not name production`);
      if (/CI\/CD/.test(at('L0'))) {
        assert.match(at('L0'), /except|不算|除外/, `${file} L0 lists CI/CD as L0 work again: ${at('L0')}`);
      }
    });
  }

  it('workflows/review-cycle.md, the fourth copy of the rule, agrees and does not hand it to the reviewer', () => {
    // Found by the second pre-tag review: it kept "config → L0" with no L3
    // branch — the rule removed from reviewer.md — and calls itself the
    // reviewer's extension guide.
    const block = section(read('workflows/review-cycle.md'), '### 计划阶段的判定规则');
    const rules = block.match(/```\n([\s\S]*?)```/)?.[1].split('\n').filter(Boolean) ?? [];
    const to = (level) => rules.find((l) => l.trim().endsWith(`→ ${level}`)) ?? '';
    for (const word of [/迁移|migration/i, /CI\/CD/, /部署|deploy/i]) assert.match(to('L2'), word, `review-cycle L2 does not name ${word}`);
    assert.match(to('L3'), /生产|production/i, 'review-cycle L3 does not name production');
    assert.match(to('L0'), /除外/, 'review-cycle L0 does not exclude CI/CD and deployment config');
  });

  it('the static reference says what the code does with review_required and L3', () => {
    // executor.js reviews L3 whatever review_required says (isL3 || …).
    const flow = section(read('references/review-classification.md'), '### L3 流程');
    assert.doesNotMatch(flow, /reviewLevel === 'L3' && review_required !== false/, 'the L3 flow is gated on review_required again');
  });

  it('planning keeps review_required on for the tasks that skip TDD, since false skips review below L3', () => {
    // Pre-tag review: an L2 "DB migration" task planned with
    // review_required: false came back auto_accepted with no reviewer. The level
    // rule alone did not hold; the flag is the other half.
    assert.match(read('src/tools/orchestrator/executor.js'),
      /const autoAccept = isL0 \|\| \(task\.review_required === false && !isL3\);/,
      'premise: review_required no longer short-circuits review below L3');
    const bullet = section(read('workflows/execution-flow.md'), '## STEP 7').split('\n').find((l) => l.includes('`review_required`'));
    assert.ok(bullet?.includes('迁移、CI/CD、部署配置') && bullet.includes('必须保持 `true`'),
      `STEP 7 does not say those tasks keep review_required: true:\n  ${bullet}`);
  });
});

describe('prompt layer — the instruction sentences', () => {
  // One home for the instructions the fixes in this file introduced — both
  // review rounds' repairs included; the first version of this list covered
  // only the first round's, while its commit message said "every". Each entry
  // was checked against a mutation that kept a word-level gate green.
  // Red: an edit inside the sentence; a word joined straight onto either end
  // ("不必等 `x`…", "…这些文件之外的文件"); a note in the same clause using one
  // of the REVOKED words ("（以上这条已废止，不要照做）"). Those passed when
  // this checked only that the sentence was present (third pre-tag review).
  // Still green (fourth pre-tag review): a negation set off by punctuation
  // ("禁止：…", "不要（…）"), a revocation in other words ("现在不用了",
  // "已经取消", "never mind") or on the next line, an exception tacked on
  // ("——除非…"), and any contradicting sentence elsewhere.
  const collapse = (t) => t.replace(/\s+/g, ' ');
  // Same length as collapse(t), so indexes carry over, but a whitespace run
  // with a line break in it stays a break: a paragraph end is a clause end.
  const lineBreaks = (t) => t.replace(/\s+/g, (w) => (w.includes('\n') ? '\n' : ' '));
  const WORD = /[\p{Script=Han}A-Za-z]/u;
  const CLAUSE_END = /[。！？；：，、.!?;:,]$/;
  const REVOKED = /废止|作废|不要照做|不必照做|忽略|不再适用|ignore|obsolete|no longer appl/i;
  const INSTRUCTIONS = [
    ['commands/doctor.md', 'Read `package.json` in the current project root for a source version only when its `name` is `gsd-lite`'],
    ['commands/doctor.md', "If the `health` response carries `warning` (the server's own version-drift check): record it as WARN"],
    ['commands/doctor.md', 'Older than 10 seconds: record WARN'],
    ['agents/reviewer.md', '不信任 executor 的报告：自己阅读代码、自己运行测试，executor 的结论和它声称的测试结果都不算证据'],
    ['agents/reviewer.md', '你不重新判定级别，也不因为改动看起来简单就降级'],
    ['agents/debugger.md', '读取运行时输出和已有日志来验证假设；不修改源码'],
    ['commands/resume.md', '**`orchestrator-resume` 响应里的 `review_targets` 原样转发** —— 不要自己从 state 里收集各 task 的'],
    ['workflows/review-cycle.md', 'reviewer 不重新判定，按每个审查对象带的 `level` 审查'],
    ['references/review-classification.md', '`review_required: false` 的 L1/L2 task 同样走此路径；L3 不受它影响'],
    ['agents/reviewer.md', '一直漏掉就一直绕圈，到不了人工确认'],
    // The refresh path: with the researcher no longer writing, a step that only
    // said "更新 state.json" wrote no documents (second pre-tag review).
    ['commands/resume.md', '把它返回的 `result` / `decision_index` / `artifacts` 原样传给 `orchestrator-handle-researcher-result`'],
    ['agents/debugger.md', '`architecture_concern` 为 true 时，编排器会把 phase 标为 failed'],
    ['README.md', 'sends an L1 or L2 task straight to accepted; only L3 ignores it.'],
    ['references/review-classification.md', '且 `review_required` 保持 `true` —— 设为 `false` 的 L1/L2 task 会跳过审查直接 accepted'],
    ['workflows/execution-flow.md', '设为 `false` 的 L1/L2 task 在 checkpoint 后直接 accepted、不经任何审查'],
    ['workflows/tdd-cycle.md', '唯一例外见下方 §例外列表。免 TDD 不降低审查级别。'],
  ];
  for (const [file, sentence] of INSTRUCTIONS) {
    it(`${file} says: ${sentence.slice(0, 40)}…`, () => {
      const raw = read(file);
      const text = collapse(raw);
      const s = collapse(sentence);
      const at = text.indexOf(s);
      assert.ok(at !== -1, `${file} no longer carries the instruction:\n  ${sentence}`);
      const lines = lineBreaks(raw);
      const before = lines.slice(Math.max(0, at - 60), at).replace(/ $/, '');
      const after = lines.slice(at + s.length, at + s.length + 60).replace(/^ /, '');
      const context = `…${before.slice(-20)}[${s.slice(0, 20)}…]${after.slice(0, 20)}…`;
      assert.ok(!WORD.test(before.at(-1) ?? ''), `${file}: a word joined before the instruction changes it: ${context}`);
      assert.ok(CLAUSE_END.test(s) || !WORD.test(after[0] ?? ''), `${file}: a word joined after the instruction changes it: ${context}`);
      const clauseBefore = before.slice(Math.max(before.lastIndexOf('。'), before.lastIndexOf('\n')) + 1);
      const ends = [after.indexOf('。'), after.indexOf('\n')].filter((i) => i !== -1);
      const clauseAfter = after.slice(0, ends.length ? Math.min(...ends) : after.length);
      assert.doesNotMatch(`${clauseBefore} ${clauseAfter}`, REVOKED, `${file}: the clause around the instruction revokes it: ${context}`);
    });
  }

  it('the debugger is not told to add log lines anywhere', () => {
    assert.doesNotMatch(read('agents/debugger.md'), /加日志/, 'debugger.md asks for an edit its role rules out');
  });
});

describe('prompt layer — examples do not expire', () => {
  it('no example expires_at is a literal date', () => {
    // collectExpiredResearch treats a past expires_at as expired, and the
    // server only checks that the value parses. A copied example date stored
    // research that was stale the moment it was written. Any literal date ages
    // into the past eventually, so the rule is "no literal", not "a later one".
    const offenders = [];
    for (const file of promptFiles) {
      read(file).split('\n').forEach((line, i) => {
        if (/"expires_at":\s*"\d{4}-\d{2}-\d{2}/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    assert.deepEqual(offenders, [], `use a placeholder; a literal date ages into the past:\n  ${offenders.join('\n  ')}`);
  });
});
