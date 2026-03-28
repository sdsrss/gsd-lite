import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Doctor is a pure prompt template (commands/doctor.md) with no runtime logic.
// Behavioral diagnostics are performed by the MCP `health` tool (tested in server.test.js).
// These tests verify the template file exists and has valid structure — nothing more.
describe('doctor command template', () => {
  it('doctor.md exists and is non-empty', async () => {
    const filePath = join(ROOT, 'commands', 'doctor.md');
    await access(filePath); // throws if missing
    const content = await readFile(filePath, 'utf-8');
    assert.ok(content.length > 0, 'doctor.md should not be empty');
  });

  it('has YAML frontmatter and required prompt sections', async () => {
    const content = await readFile(join(ROOT, 'commands', 'doctor.md'), 'utf-8');
    assert.match(content, /^---\n/, 'should start with YAML frontmatter');
    assert.match(content, /description:/, 'should have a description field');
    assert.match(content, /<role>[\s\S]*<\/role>/, 'should have a <role> section');
    assert.match(content, /<process>[\s\S]*<\/process>/, 'should have a <process> section');
    assert.match(content, /<rules>[\s\S]*<\/rules>/, 'should have a <rules> section');
  });
});
