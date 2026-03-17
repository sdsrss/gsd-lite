import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const HOOK_PATH = join(import.meta.dirname, '..', 'hooks', 'gsd-statusline.cjs');

/**
 * Helper: run the statusline hook with given JSON input and optional cwd override.
 * Returns { stdout, stderr, status }.
 */
function runHook(inputData, opts = {}) {
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
