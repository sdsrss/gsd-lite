import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const HOOK_PATH = join(import.meta.dirname, '..', 'hooks', 'gsd-statusline.cjs');

// The hook writes a context bridge file per session id into os.tmpdir(). Nothing
// removed them, so every run of this suite left orphans behind; record each id
// runHook uses and clear them when the file is done.
const bridgeSessions = new Set();
function clearBridgeFiles() {
  for (const id of bridgeSessions) {
    try { rmSync(join(tmpdir(), `gsd-ctx-${id}.json`), { force: true }); } catch { /* best effort */ }
  }
  bridgeSessions.clear();
}
after(clearBridgeFiles);

/**
 * Helper: run the statusline hook with given JSON input and optional cwd override.
 * Returns { stdout, stderr, status }.
 */
function runHook(inputData, opts = {}) {
  const sessionId = String(inputData?.session_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (sessionId) bridgeSessions.add(sessionId);
  const input = JSON.stringify(inputData);
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, GSD_DEBUG: '1', ...(opts.env || {}) },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', status: err.status };
  }
}

describe('gsd-statusline ancestor traversal', () => {
  let rootDir;

  before(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'gsd-statusline-'));
  });

  after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('finds .gsd in ancestor directory when cwd is a subdirectory', async () => {
    // Create project/.gsd/state.json
    const projectDir = join(rootDir, 'project');
    const gsdDir = join(projectDir, '.gsd');
    await mkdir(gsdDir, { recursive: true });
    await writeFile(join(gsdDir, 'state.json'), JSON.stringify({
      current_task: 'T1',
      current_phase: 'P1',
      phases: [{ id: 'P1', todo: [{ id: 'T1', name: 'Test Task' }] }],
    }));

    // cwd is project/src/components (nested subdirectory)
    const nestedDir = join(projectDir, 'src', 'components');
    await mkdir(nestedDir, { recursive: true });

    const result = runHook({
      model: { display_name: 'Claude' },
      workspace: { current_dir: nestedDir },
      session_id: 'test-ancestor-1',
      context_window: { remaining_percentage: 80 },
    });

    // Should find the task from ancestor's .gsd/state.json
    assert.ok(result.stdout.includes('T1 Test Task'),
      `Expected stdout to include task "T1 Test Task", got: ${JSON.stringify(result.stdout)}`);
  });

  it('writes .context-health to the found ancestor .gsd directory', async () => {
    const projectDir = join(rootDir, 'project2');
    const gsdDir = join(projectDir, '.gsd');
    await mkdir(gsdDir, { recursive: true });
    await writeFile(join(gsdDir, 'state.json'), JSON.stringify({}));

    const nestedDir = join(projectDir, 'deep', 'nested', 'dir');
    await mkdir(nestedDir, { recursive: true });

    runHook({
      model: { display_name: 'Claude' },
      workspace: { current_dir: nestedDir },
      session_id: 'test-ancestor-2',
      context_window: { remaining_percentage: 65 },
    });

    // .context-health should be written in the FOUND .gsd, not in nestedDir/.gsd
    const healthPath = join(gsdDir, '.context-health');
    assert.ok(existsSync(healthPath),
      `Expected .context-health at ${healthPath} but it does not exist`);
    const content = readFileSync(healthPath, 'utf8').trim();
    assert.equal(content, '65');

    // Should NOT have created .gsd in the nested directory
    assert.ok(!existsSync(join(nestedDir, '.gsd')),
      'Should not create .gsd in the nested cwd directory');
  });

  it('gracefully handles no .gsd found anywhere (returns output without task)', async () => {
    // Create a directory tree with NO .gsd anywhere
    const isolatedDir = join(rootDir, 'isolated', 'deep', 'path');
    await mkdir(isolatedDir, { recursive: true });

    const result = runHook({
      model: { display_name: 'TestModel' },
      workspace: { current_dir: isolatedDir },
      session_id: 'test-no-gsd',
      context_window: { remaining_percentage: 90 },
    });

    // Should still output model and dirname (no crash)
    assert.ok(result.stdout.includes('TestModel'),
      `Expected stdout to include model name, got: ${JSON.stringify(result.stdout)}`);
    assert.ok(result.stdout.includes('path'),
      `Expected stdout to include dirname "path", got: ${JSON.stringify(result.stdout)}`);
    assert.equal(result.status, 0, 'Should exit cleanly');
  });

  it('does not create .gsd directory when none exists and context-health is written', async () => {
    // No .gsd anywhere — context-health write should be skipped, not create .gsd in cwd
    const noGsdDir = join(rootDir, 'no-gsd-project', 'src');
    await mkdir(noGsdDir, { recursive: true });

    runHook({
      model: { display_name: 'Claude' },
      workspace: { current_dir: noGsdDir },
      session_id: 'test-no-create',
      context_window: { remaining_percentage: 50 },
    });

    // Should NOT have created .gsd anywhere in the chain
    assert.ok(!existsSync(join(noGsdDir, '.gsd')),
      'Should not create .gsd in cwd when no .gsd found');
    assert.ok(!existsSync(join(rootDir, 'no-gsd-project', '.gsd')),
      'Should not create .gsd in parent when no .gsd found');
  });

  it('finds .gsd in the exact cwd (existing behavior preserved)', async () => {
    const projectDir = join(rootDir, 'exact-cwd');
    const gsdDir = join(projectDir, '.gsd');
    await mkdir(gsdDir, { recursive: true });
    await writeFile(join(gsdDir, 'state.json'), JSON.stringify({
      current_task: 'T2',
      current_phase: 'P2',
      phases: [{ id: 'P2', todo: [{ id: 'T2', name: 'Direct Task' }] }],
    }));

    const result = runHook({
      model: { display_name: 'Claude' },
      workspace: { current_dir: projectDir },
      session_id: 'test-exact-cwd',
      context_window: { remaining_percentage: 70 },
    });

    assert.ok(result.stdout.includes('T2 Direct Task'),
      `Expected stdout to include task "T2 Direct Task", got: ${JSON.stringify(result.stdout)}`);
  });

  it('bridge file still gets has_gsd=true when .gsd found via ancestor', async () => {
    const projectDir = join(rootDir, 'bridge-test');
    const gsdDir = join(projectDir, '.gsd');
    await mkdir(gsdDir, { recursive: true });
    await writeFile(join(gsdDir, 'state.json'), JSON.stringify({}));

    const nestedDir = join(projectDir, 'src');
    await mkdir(nestedDir, { recursive: true });

    // Use unique session ID to avoid stale bridge file from previous runs
    const sessionId = `test-bridge-ancestor-${Date.now()}`;
    const bridgePath = join(tmpdir(), `gsd-ctx-${sessionId}.json`);
    // Clean up any pre-existing bridge file
    try { await rm(bridgePath); } catch {}

    runHook({
      model: { display_name: 'Claude' },
      workspace: { current_dir: nestedDir },
      session_id: sessionId,
      context_window: { remaining_percentage: 55 },
    });

    assert.ok(existsSync(bridgePath),
      `Expected bridge file at ${bridgePath}`);
    const bridge = JSON.parse(readFileSync(bridgePath, 'utf8'));
    assert.equal(bridge.has_gsd, true,
      'Bridge file should have has_gsd=true when .gsd found via ancestor');

    // Cleanup bridge file
    try { await rm(bridgePath); } catch {}
  });

  it('truncates long task names to 40 characters', async () => {
    const projectDir = join(rootDir, 'long-task-name');
    const gsdDir = join(projectDir, '.gsd');
    await mkdir(gsdDir, { recursive: true });
    const longName = 'A'.repeat(60);
    await writeFile(join(gsdDir, 'state.json'), JSON.stringify({
      current_task: 'T1',
      current_phase: 'P1',
      phases: [{ id: 'P1', todo: [{ id: 'T1', name: longName }] }],
    }));

    const result = runHook({
      model: { display_name: 'Claude' },
      workspace: { current_dir: projectDir },
      session_id: 'test-truncate-1',
      context_window: { remaining_percentage: 80 },
    });

    // Should show truncated name (40 chars + "...")
    assert.ok(result.stdout.includes('A'.repeat(40) + '...'),
      `Expected truncated task name, got: ${JSON.stringify(result.stdout)}`);
    assert.ok(!result.stdout.includes('A'.repeat(41)),
      'Should not contain more than 40 A characters before ellipsis');
  });

  it('does not truncate short task names', async () => {
    const projectDir = join(rootDir, 'short-task-name');
    const gsdDir = join(projectDir, '.gsd');
    await mkdir(gsdDir, { recursive: true });
    await writeFile(join(gsdDir, 'state.json'), JSON.stringify({
      current_task: 'T1',
      current_phase: 'P1',
      phases: [{ id: 'P1', todo: [{ id: 'T1', name: 'Short name' }] }],
    }));

    const result = runHook({
      model: { display_name: 'Claude' },
      workspace: { current_dir: projectDir },
      session_id: 'test-truncate-2',
      context_window: { remaining_percentage: 80 },
    });

    assert.ok(result.stdout.includes('T1 Short name'),
      `Expected full task name, got: ${JSON.stringify(result.stdout)}`);
    assert.ok(!result.stdout.includes('...'),
      'Should not have ellipsis for short names');
  });
});

// ── Regression: a non-numeric context percentage must not render "NaN%" ──
// remaining_percentage flowed into the arithmetic unchecked. A non-numeric
// value produced NaN, which renders an empty bar labelled "NaN%" and, because
// every `used < N` comparison is false for NaN, painted it in the blinking-red
// critical style — a false context-exhaustion alarm on every prompt.
describe('statusline: non-numeric context percentage', () => {
  // JSON.stringify turns NaN and Infinity into null, so passing those over the
  // hook's stdin would exercise the pre-existing `!= null` gate, not this one.
  // Every case below survives JSON round-tripping as a non-null non-number.
  for (const [label, value] of [
    ['a string', 'lots'],
    ['the string "NaN"', 'NaN'],
    ['an object', {}],
    ['an array', []],
    ['a boolean', true],
    ['an empty string', ''],
  ]) {
    it(`omits the context bar when remaining_percentage is ${label}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'gsd-sl-nan-'));
      try {
        const gsdDir = join(dir, '.gsd');
        await mkdir(gsdDir, { recursive: true });
        await writeFile(join(gsdDir, 'state.json'), JSON.stringify({
          project: 'p', current_phase: 1, current_task: '1.1',
          phases: [{ id: 1, todo: [{ id: '1.1', name: 'Task', lifecycle: 'running' }] }],
        }));
        const { stdout: out } = runHook({
          session_id: 'nan-test',
          workspace: { current_dir: dir },
          model: { display_name: 'Opus' },
          context_window: { remaining_percentage: value },
        });
        assert.ok(!out.includes('NaN'), `statusline rendered NaN: ${JSON.stringify(out)}`);
        assert.ok(!out.includes('💀'), 'must not raise a false critical-context alarm');
        assert.ok(out.includes('Opus'), 'the rest of the line still renders');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it('accepts a numeric string rather than dropping the bar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-sl-nan-'));
    try {
      await mkdir(join(dir, '.gsd'), { recursive: true });
      await writeFile(join(dir, '.gsd', 'state.json'), JSON.stringify({ project: 'p', phases: [] }));
      const { stdout: out } = runHook({
        session_id: 'numstr-test',
        workspace: { current_dir: dir },
        model: { display_name: 'Opus' },
        context_window: { remaining_percentage: '90' },
      });
      assert.match(out, /\d+%/, 'a numeric string still renders a bar');
      assert.ok(!out.includes('NaN'), 'and does not render NaN');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('renders the extremes without a false critical alarm at 100', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-sl-nan-'));
    try {
      await mkdir(join(dir, '.gsd'), { recursive: true });
      await writeFile(join(dir, '.gsd', 'state.json'), JSON.stringify({ project: 'p', phases: [] }));
      // 0 is falsy — it must not be dropped by the finite check
      const { stdout: zero } = runHook({
        session_id: 'zero-test',
        workspace: { current_dir: dir },
        model: { display_name: 'Opus' },
        context_window: { remaining_percentage: 0 },
      });
      assert.match(zero, /100%/, 'no context left renders as 100% used');
      const { stdout: full } = runHook({
        session_id: 'full-test',
        workspace: { current_dir: dir },
        model: { display_name: 'Opus' },
        context_window: { remaining_percentage: 100 },
      });
      assert.match(full, /0%/, 'a full window renders as 0% used');
      assert.ok(!full.includes('\u{1F480}'), 'a full window is not a critical alarm');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still renders the bar for a valid percentage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-sl-nan-'));
    try {
      await mkdir(join(dir, '.gsd'), { recursive: true });
      await writeFile(join(dir, '.gsd', 'state.json'), JSON.stringify({ project: 'p', phases: [] }));
      const { stdout: out } = runHook({
        session_id: 'ok-test',
        workspace: { current_dir: dir },
        model: { display_name: 'Opus' },
        context_window: { remaining_percentage: 90 },
      });
      assert.match(out, /\d+%/, 'a numeric percentage still renders');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A planted symlink at the bridge path must be evicted, not honoured. Refusing
  // to write one was tried and reverted: the rename never followed a link in the
  // first place, so refusing added no safety and instead pinned the bridge to
  // whatever was behind the link — freezing the reported context percentage for
  // that session, where the previous release self-healed on the next run.
  it('evicts a symlink planted at the bridge path instead of honouring it', () => {
    const sid = `sym-${Date.now()}`;
    bridgeSessions.add(sid);
    const bridgePath = join(tmpdir(), `gsd-ctx-${sid}.json`);
    const decoy = join(tmpdir(), `gsd-ctx-${sid}-decoy.json`);
    try {
      writeFileSync(decoy, JSON.stringify({ remaining_percentage: 99, has_gsd: false }));
      symlinkSync(decoy, bridgePath);

      runHook({ session_id: sid, model: { display_name: 'Test' }, context_window: { remaining_percentage: 20 } });

      assert.equal(lstatSync(bridgePath).isSymbolicLink(), false, 'the bridge is still pinned to the planted link');
      assert.equal(JSON.parse(readFileSync(decoy, 'utf8')).remaining_percentage, 99,
        'the decoy was written through');
      assert.equal(JSON.parse(readFileSync(bridgePath, 'utf8')).remaining_percentage, 20);
    } finally {
      try { rmSync(decoy, { force: true }); } catch { /* best effort */ }
    }
  });

  // A FIFO at .gsd/.context-health hung the hook forever: the read happens
  // before the write decision, so no write-side hardening touches it, and a
  // try/catch does nothing for a blocking read. Every later render hung too.
  it('does not hang when .context-health is a fifo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-statusline-fifo-'));
    try {
      const gsdDir = join(root, '.gsd');
      await mkdir(gsdDir, { recursive: true });
      await writeFile(join(gsdDir, 'state.json'), JSON.stringify({
        schema_version: 'v1', project: 'p', workflow_mode: 'executing_task',
        current_phase: 1, current_task: null, total_phases: 1, phases: [],
      }));
      execFileSync('mkfifo', [join(root, 'pipe')]);
      symlinkSync(join(root, 'pipe'), join(gsdDir, '.context-health'));

      const sid = `fifo-${Date.now()}`;
      bridgeSessions.add(sid);
      // execFileSync throws ETIMEDOUT on a hang, which is the failure we want.
      const out = execFileSync(process.execPath, [HOOK_PATH], {
        input: JSON.stringify({
          session_id: sid,
          model: { display_name: 'Test' },
          workspace: { current_dir: root },
          context_window: { remaining_percentage: 37 },
        }),
        encoding: 'utf8',
        timeout: 6000,
      });
      assert.match(out, /37%|\d+%/, 'the statusline should still render');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Dropping the try/catch around the state.json block traded a caught TypeError
  // for a silent one: `phases` present but not an array made `.find` throw, the
  // outer handler swallowed it, and the throw happened BEFORE the bridge write
  // and the .context-health write — so a malformed field took out the whole
  // statusline plus both side effects. .context-health feeds the awaiting_clear
  // resume gate and the bridge feeds the exhaustion warnings, so the cost of
  // this is context tracking going quiet, which nothing reports.
  it('still renders and still writes the bridge when phases is not an array', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-statusline-badphases-'));
    try {
      const gsdDir = join(root, '.gsd');
      await mkdir(gsdDir, { recursive: true });
      await writeFile(join(gsdDir, 'state.json'), JSON.stringify({
        schema_version: 'v1', project: 'p', workflow_mode: 'executing_task',
        current_phase: 1, current_task: '1.1', total_phases: 1, phases: 'oops',
      }));

      const sid = `badphases-${Date.now()}`;
      const out = runHook({
        session_id: sid,
        model: { display_name: 'Test' },
        workspace: { current_dir: root },
        context_window: { remaining_percentage: 44 },
      }).stdout;

      assert.match(out, /\d+%/, 'the statusline did not render');
      assert.equal(existsSync(join(tmpdir(), `gsd-ctx-${sid}.json`)), true,
        'the bridge file was never written, so context warnings are dead for this session');
      assert.equal(existsSync(join(gsdDir, '.context-health')), true,
        '.context-health was never written, so the awaiting_clear resume gate has nothing to read');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Same failure, one path over. The guard above landed on the marker files and
  // left .gsd/state.json on a bare readFileSync, which a hostile checkout
  // controls just as directly — and the statusline reads it on every render.
  it('does not hang when .gsd/state.json is a fifo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gsd-statusline-statefifo-'));
    try {
      const gsdDir = join(root, '.gsd');
      await mkdir(gsdDir, { recursive: true });
      execFileSync('mkfifo', [join(gsdDir, 'state.json')]);

      const sid = `statefifo-${Date.now()}`;
      bridgeSessions.add(sid);
      const out = execFileSync(process.execPath, [HOOK_PATH], {
        input: JSON.stringify({
          session_id: sid,
          model: { display_name: 'Test' },
          workspace: { current_dir: root },
          context_window: { remaining_percentage: 41 },
        }),
        encoding: 'utf8',
        timeout: 6000,
      });
      assert.match(out, /41%|\d+%/, 'the statusline should still render');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
