import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { init, read, update, phaseComplete } from './tools/state.js';

const server = new Server(
  { name: 'gsd-lite', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
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
              name: { type: 'string' },
              tasks: { type: 'array' },
            },
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
      },
      required: ['phase_id'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let result;

  switch (name) {
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
    default:
      result = { error: true, message: `Unknown tool: ${name}` };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
