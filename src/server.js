import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { init, read, update, phaseComplete } from './tools/state.js';

const _require = createRequire(import.meta.url);
const PKG_VERSION = _require('../package.json').version;
import {
  handleDebuggerResult,
  handleExecutorResult,
  handleResearcherResult,
  handleReviewerResult,
  resumeWorkflow,
} from './tools/orchestrator.js';

const server = new Server(
  { name: 'gsd-lite', version: PKG_VERSION },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'gsd-health',
    description: 'Health check: returns server status and whether .gsd state exists',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'gsd-state-init',
    description: 'Initialize .gsd/ directory with state.json, plan.md, and phases/*.md',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name' },
        phases: {
          type: 'array',
          description: 'Phase definitions with tasks',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Phase name' },
              tasks: {
                type: 'array',
                description: 'Task definitions',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Task name (required)' },
                    index: { type: 'number', description: 'Task index within phase (default: auto)' },
                    level: { type: 'string', description: 'Complexity level: L0/L1/L2/L3 (default: L1)' },
                    requires: { type: 'array', description: 'Dependency list (default: [])' },
                    review_required: { type: 'boolean', description: 'Whether review is needed (default: true)' },
                    verification_required: { type: 'boolean', description: 'Whether verification is needed (default: true)' },
                  },
                  required: ['name'],
                },
              },
            },
            required: ['name'],
          },
        },
        research: { type: 'boolean', description: 'Whether research directory is needed' },
      },
      required: ['project', 'phases'],
    },
  },
  {
    name: 'gsd-state-read',
    description: 'Read state.json, optionally filtering to specific fields',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional field names to return (returns all if omitted)',
        },
      },
    },
  },
  {
    name: 'gsd-state-update',
    description: 'Update state.json canonical fields with lifecycle validation',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'object',
          description: 'Key-value pairs of canonical fields to update',
        },
      },
      required: ['updates'],
    },
  },
  {
    name: 'gsd-phase-complete',
    description: 'Mark a phase as complete after verifying handoff gate conditions',
    inputSchema: {
      type: 'object',
      properties: {
        phase_id: { type: 'number', description: 'Phase number to complete' },
        verification: {
          type: 'object',
          description: 'Optional precomputed verification result object with lint/typecheck/test exit codes',
        },
        run_verify: {
          type: 'boolean',
          description: 'When true, run lint/typecheck/test during handoff evaluation',
        },
        direction_ok: {
          type: 'boolean',
          description: 'Optional direction drift check result; false moves workflow into awaiting_user',
        },
      },
      required: ['phase_id'],
    },
  },
  {
    name: 'gsd-orchestrator-resume',
    description: 'Resume the minimal orchestration loop from workflow_mode/current_phase state',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'gsd-orchestrator-handle-executor-result',
    description: 'Persist an executor result and determine the next orchestration action',
    inputSchema: {
      type: 'object',
      properties: {
        result: { type: 'object', description: 'Executor result payload' },
      },
      required: ['result'],
    },
  },
  {
    name: 'gsd-orchestrator-handle-debugger-result',
    description: 'Persist a debugger result and determine the next orchestration action',
    inputSchema: {
      type: 'object',
      properties: {
        result: { type: 'object', description: 'Debugger result payload' },
      },
      required: ['result'],
    },
  },
  {
    name: 'gsd-orchestrator-handle-researcher-result',
    description: 'Persist a researcher result, write .gsd/research artifacts, and continue orchestration',
    inputSchema: {
      type: 'object',
      properties: {
        result: { type: 'object', description: 'Researcher result payload' },
        decision_index: { type: 'object', description: 'Decision index keyed by decision id' },
        artifacts: { type: 'object', description: 'Markdown artifact contents keyed by file name' },
      },
      required: ['result', 'decision_index', 'artifacts'],
    },
  },
  {
    name: 'gsd-orchestrator-handle-reviewer-result',
    description: 'Persist a reviewer result, update task lifecycles, and determine next orchestration action',
    inputSchema: {
      type: 'object',
      properties: {
        result: { type: 'object', description: 'Reviewer result payload' },
      },
      required: ['result'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

async function dispatchToolCall(name, args) {
  let result;
  switch (name) {
    case 'gsd-health': {
      const stateResult = await read(args || {});
      result = {
        status: 'ok',
        server: 'gsd-lite',
        version: PKG_VERSION,
        state_exists: !stateResult.error,
        ...(stateResult.error ? {} : {
          project: stateResult.project,
          workflow_mode: stateResult.workflow_mode,
          current_phase: stateResult.current_phase,
          total_phases: stateResult.total_phases,
        }),
      };
      break;
    }
    case 'gsd-state-init':
      result = await init(args);
      break;
    case 'gsd-state-read':
      result = await read(args || {});
      break;
    case 'gsd-state-update':
      result = await update(args);
      break;
    case 'gsd-phase-complete':
      result = await phaseComplete(args);
      break;
    case 'gsd-orchestrator-resume':
      result = await resumeWorkflow(args || {});
      break;
    case 'gsd-orchestrator-handle-executor-result':
      result = await handleExecutorResult(args || {});
      break;
    case 'gsd-orchestrator-handle-debugger-result':
      result = await handleDebuggerResult(args || {});
      break;
    case 'gsd-orchestrator-handle-researcher-result':
      result = await handleResearcherResult(args || {});
      break;
    case 'gsd-orchestrator-handle-reviewer-result':
      result = await handleReviewerResult(args || {});
      break;
    default:
      result = { error: true, message: `Unknown tool: ${name}` };
  }

  return result;
}

export async function handleToolCall(name, args) {
  try {
    return await dispatchToolCall(name, args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: true, message: `Tool execution failed: ${message}` };
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const result = await handleToolCall(name, args);

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
});

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(console.error);
}
