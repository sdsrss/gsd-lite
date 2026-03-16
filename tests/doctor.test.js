import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

describe('doctor command', () => {
  let content;

  it('doctor.md exists and is readable', async () => {
    content = await readFile(join(ROOT, 'commands', 'doctor.md'), 'utf-8');
    assert.ok(content.length > 0, 'doctor.md should not be empty');
  });

  it('has YAML frontmatter with description', async () => {
    content = content || await readFile(join(ROOT, 'commands', 'doctor.md'), 'utf-8');
    assert.match(content, /^---\n/, 'should start with YAML frontmatter');
    assert.match(content, /description:/, 'should have a description field');
    assert.match(content, /---\n/, 'should close YAML frontmatter');
  });

  it('has a role section', async () => {
    content = content || await readFile(join(ROOT, 'commands', 'doctor.md'), 'utf-8');
    assert.match(content, /<role>/, 'should have a <role> section');
    assert.match(content, /<\/role>/, 'should close the <role> section');
  });

  it('has a process section with diagnostic steps', async () => {
    content = content || await readFile(join(ROOT, 'commands', 'doctor.md'), 'utf-8');
    assert.match(content, /<process>/, 'should have a <process> section');
    assert.match(content, /<\/process>/, 'should close the <process> section');
  });

  it('checks state.json validity', async () => {
    content = content || await readFile(join(ROOT, 'commands', 'doctor.md'), 'utf-8');
    assert.match(content, /state\.json/, 'should check state.json');
  });

  it('checks MCP server health', async () => {
    content = content || await readFile(join(ROOT, 'commands', 'doctor.md'), 'utf-8');
    assert.match(content, /health/i, 'should check MCP server health');
  });

  it('checks hooks registration', async () => {
    content = content || await readFile(join(ROOT, 'commands', 'doctor.md'), 'utf-8');
    assert.match(content, /hooks/i, 'should check hooks');
  });

  it('checks for stale lock file', async () => {
    content = content || await readFile(join(ROOT, 'commands', 'doctor.md'), 'utf-8');
    assert.match(content, /lock/i, 'should check for lock file');
  });

  it('checks update status', async () => {
    content = content || await readFile(join(ROOT, 'commands', 'doctor.md'), 'utf-8');
    assert.match(content, /update/i, 'should check update status');
  });

  it('outputs a summary with checkmarks', async () => {
    content = content || await readFile(join(ROOT, 'commands', 'doctor.md'), 'utf-8');
    assert.match(content, /summary/i, 'should output a summary');
  });

  it('has a rules section', async () => {
    content = content || await readFile(join(ROOT, 'commands', 'doctor.md'), 'utf-8');
    assert.match(content, /<rules>/, 'should have a <rules> section');
    assert.match(content, /<\/rules>/, 'should close the <rules> section');
  });
});
