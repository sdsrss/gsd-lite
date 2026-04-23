# GSD-Lite

> Get Shit Done — AI orchestration for Claude Code

GSD-Lite is an AI orchestration tool for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It combines structured project management with built-in quality discipline: TDD enforcement, anti-rationalization guards, multi-level code review, and automatic failure recovery — all driven by a 12-state workflow machine that keeps multi-phase projects on track.

**Discuss thoroughly, execute automatically.** Have as many rounds of requirement discussion as needed. Once the plan is approved, GSD-Lite auto-executes: coding, self-review, independent review, verification, and phase advancement — with minimal human intervention.

## Features

### Structured Execution Engine
- **Phase-based project management** — Break work into phases with ordered tasks, dependency tracking, and handoff gates
- **12-state workflow machine** — `planning → executing_task → reviewing_task → reviewing_phase → completed` with precise transitions, persistent to `state.json`
- **Automatic task scheduling** — Gate-aware dependency resolution determines what runs next
- **Session resilience** — Stop anytime, resume exactly where you left off — crash protection via Stop hook auto-saves state markers

### Quality Discipline (Built-in, Not Optional)
- **TDD enforcement** — "No production code without a failing test first" baked into every executor dispatch
- **Anti-rationalization guards** — Red-flag checklists inline in every agent prompt, blocking common excuses to skip process
- **Multi-level code review** — L0 self-review / L1 phase-batch review / L2 immediate independent review / phase review retry limit
- **Contract change propagation** — When an API contract changes, downstream tasks automatically invalidate

### Intelligent Failure Recovery
- **3-strike retry with debugger escalation** — Failed tasks retry up to 3 times, then auto-dispatch a debugger agent
- **Systematic root cause analysis** — Debugger tests hypotheses, finds root cause, feeds fix guidance back to executor
- **Blocked task handling** — Blocked tasks are parked; execution continues with remaining tasks
- **Rework propagation** — Critical review issues cascade invalidation to dependent tasks

### Adaptive Review & Parallel Execution
- **Confidence-based review adjustment** — Executor self-assesses confidence (high/medium/low); orchestrator auto-adjusts review level with evidence cross-validation
- **Impact analysis before review** — Reviewer runs impact analysis on multi-file changes to catch missed downstream effects
- **Parallel task scheduling** — Independent tasks within the same phase are identified for concurrent dispatch
- **Auto PR suggestion** — Phase/project completion prompts PR creation with evidence summary

### Context Protection & Monitoring
- **Subagent isolation** — Each task runs in its own agent context, preventing cross-contamination
- **Real-time context health monitoring** — StatusLine tracks context usage and project phase; composite StatusLine support coexists with other plugins
- **Session lifecycle hooks** — Stop hook writes crash marker; SessionStart injects project status into CLAUDE.md; resume detects non-graceful exits
- **Evidence-based verification** — Every claim backed by command output, not assertions
- **Research with TTL** — Research artifacts include volatility ratings and expiration dates

### Auto-Update & Version Management
- **Automatic update checks** — Checks GitHub Releases every 24 hours with rate-limit backoff
- **Version drift detection** — Server startup compares running version against disk and plugin registry, warns on mismatch
- **Smart cache management** — Keeps latest 3 cached versions, auto-prunes old entries
- **Idempotent installer** — Reinstall anytime without uninstalling; legacy files auto-cleaned

## Architecture

```
User → discuss + research (confirm requirements) → approve plan → auto-execute
        ↑                      ↑                        ↑
     Interaction 1          Interaction 2          Autonomous execution
                                              (code→review→verify→advance)
```

### 6 Commands

| Command | Purpose |
|---------|---------|
| `/gsd:start` | Interactive start — discuss requirements, research, plan, then auto-execute |
| `/gsd:prd <input>` | Start from a requirements doc or description text |
| `/gsd:resume` | Resume execution from saved state with workspace validation |
| `/gsd:status` | View project progress dashboard (derived from canonical state fields) |
| `/gsd:stop` | Save state and pause execution |
| `/gsd:doctor` | Diagnostic checks on GSD-Lite installation and project health |

### 4 Agents

| Agent | Role | Built-in Discipline |
|-------|------|---------------------|
| **executor** | Execute a single task (TDD + self-review + checkpoint) | Iron Law + Red Flags + Deviation Rules |
| **reviewer** | Two-stage review (spec check → quality check) | Independent verification + Hard Gates |
| **researcher** | Ecosystem research (Context7 → official docs → web) | Confidence scoring + TTL |
| **debugger** | 4-phase systematic root cause analysis | Root Cause Iron Law |

### 6 Workflows

| Workflow | Purpose |
|----------|---------|
| `tdd-cycle` | RED-GREEN-REFACTOR TDD cycle enforcement |
| `review-cycle` | Two-level review gates and accept/rework decisions |
| `debugging` | 4-phase root cause analysis process |
| `research` | Research with confidence scoring and TTL expiration |
| `deviation-rules` | Anti-rationalization guards and red-flag checklists |
| `execution-flow` | Complete task execution cycle from dispatch to checkpoint |

### MCP Server (11 Tools)

| Tool | Purpose |
|------|---------|
| `health` | Server status and state existence check |
| `state-init` | Initialize `.gsd/` directory with project structure |
| `state-read` | Read state with optional field filtering |
| `state-update` | Update canonical fields with lifecycle validation |
| `state-patch` | Incrementally modify plan (add/remove/reorder tasks, update fields, add dependencies) |
| `phase-complete` | Complete a phase after verifying handoff gates |
| `orchestrator-resume` | Resume orchestration from current state |
| `orchestrator-handle-executor-result` | Process executor output, advance lifecycle |
| `orchestrator-handle-reviewer-result` | Process review, trigger accept/rework |
| `orchestrator-handle-researcher-result` | Store research artifacts and decisions |
| `orchestrator-handle-debugger-result` | Process root cause analysis, re-dispatch executor |

### 8 References

| Reference | Content |
|-----------|---------|
| `execution-loop` | 9-step execution loop specification (single source of truth) |
| `review-classification` | Review level classification decision tree (L0/L1/L2) |
| `evidence-spec` | Evidence validation and citation rules |
| `state-diagram` | 12-state lifecycle workflow machine diagram |
| `testing-patterns` | Test structure and patterns |
| `anti-rationalization-full` | Full red-flag checklist for agents |
| `git-worktrees` | Git worktree isolation strategy |
| `questioning` | Requirements clarification patterns |

## Installation

### Method 1: Claude Code Plugin (Recommended)

```bash
# Step 1: Add the marketplace
/plugin marketplace add sdsrss/gsd-lite

# Step 2: Install the plugin
/plugin install gsd
```

Automatically registers all commands, agents, workflows, MCP server, hooks, and auto-update. Run these commands inside a Claude Code session.

### Method 2: npx

```bash
npx gsd-lite install
```

### Method 3: Manual

```bash
git clone https://github.com/sdsrss/gsd-lite.git
cd gsd-lite && npm install && node cli.js install
```

Methods 2 & 3 write components to `~/.claude/` and register the MCP server in `settings.json`.

The installer copies commands, agents, workflows, references, and hooks to `~/.claude/`, and sets up the MCP server runtime in `~/.claude/gsd/`.

Uninstall: `node cli.js uninstall` or `npx gsd-lite uninstall`

## Upgrade

```bash
# Plugin (auto-update checks GitHub Releases every 24h)
/plugin update gsd

# npx
npx gsd-lite install

# Manual
git pull && npm install && node cli.js install
```

- Installer is idempotent — no need to uninstall first
- Upgrades from older versions auto-clean legacy files
- Smart cache management keeps latest 3 versions, prunes old entries
- Restart Claude Code after updating to load new MCP server / hooks

## Quick Start

### Interactive Start

```bash
/gsd:start
```

GSD-Lite will:
1. Analyze your codebase (tech stack, conventions, structure)
2. Ask what you want to build
3. Research the ecosystem (libraries, patterns, pitfalls)
4. Present a phased plan for your approval
5. Auto-execute all phases once approved

### From Requirements

```bash
# From a requirements document
/gsd:prd docs/requirements.md

# From a description
/gsd:prd "Build a REST API with JWT auth, rate limiting, and PostgreSQL"
```

### Resume After Interruption

```bash
/gsd:resume
```

Validates workspace consistency (git HEAD, file integrity), then resumes from the exact task and workflow mode where execution stopped.

### Monitor Progress

```bash
/gsd:status
```

Shows phase completion, task lifecycle states, review status, and blockers — all derived from canonical state fields in real-time.

## How It Works

### Execution Loop

```
1. orchestrator-resume → determines next action
2. dispatch executor → runs task with TDD discipline
3. executor checkpoints → saves work + evidence
4. dispatch reviewer → independent spec + quality review
5. reviewer accepts → task done, schedule next
   reviewer rejects → rework with specific feedback
6. all tasks done → phase handoff gate check
7. gate passes → advance to next phase
8. all phases done → project complete
```

### Failure Recovery

```
executor fails (attempt 1) → retry with context
executor fails (attempt 2) → retry with accumulated context
executor fails (attempt 3) → dispatch debugger
debugger analyzes → root cause + fix direction
executor retries → with debugger guidance injected
```

### State Persistence

All state lives in `.gsd/state.json` — a single source of truth with:
- Canonical fields (whitelist-controlled, schema-validated)
- Lifecycle state machine (pending → running → checkpointed → accepted)
- Optimistic concurrency control (`_version` field with `VERSION_CONFLICT` detection)
- Evidence references (command outputs, test results)
- Research artifacts and decision index
- Incremental validation (simple field updates use fast path; phases use full validation)

## Comparison with GSD

| Dimension | GSD | GSD-Lite |
|-----------|-----|----------|
| Commands | 32 | **6** |
| Agents | 12 | **4** |
| Source files | 100+ | **~15** |
| Installer | 2465 lines | **~290 lines** |
| User interactions | 6+ confirmations | **Typically 2** |
| TDD / Anti-rationalization | No | **Yes** |
| State machine recovery | Partial | **Full (12 modes)** |
| Evidence-based verification | No | **Yes** |
| Auto-update | No | **Yes** |
| Context health monitoring | No | **Yes** |

## Project Structure

```
gsd-lite/
├── src/                    # MCP Server + tools (15 source files)
│   ├── server.js           # MCP Server entry (11 tools + version drift detection)
│   ├── schema.js           # State schema + lifecycle validation + incremental validation
│   ├── utils.js            # Shared utilities (atomic writes, git, file lock)
│   └── tools/
│       ├── state/          # State management (modular)
│       │   ├── constants.js  # Error codes, lock infrastructure
│       │   ├── crud.js       # CRUD operations + plan patching
│       │   ├── logic.js      # Task scheduling, propagation, research
│       │   └── index.js      # Re-exports
│       ├── orchestrator/   # Orchestration logic (modular)
│       │   ├── helpers.js    # Shared constants, preflight, dispatch
│       │   ├── resume.js     # Workflow resume state machine (12 modes)
│       │   ├── executor.js   # Executor result handler
│       │   ├── reviewer.js   # Reviewer result handler
│       │   ├── debugger.js   # Debugger result handler
│       │   ├── researcher.js # Researcher result handler
│       │   └── index.js      # Re-exports
│       └── verify.js       # lint/typecheck/test verification
├── commands/               # 6 slash commands (start, prd, resume, status, stop, doctor)
├── agents/                 # 4 subagent prompts (executor, reviewer, researcher, debugger)
├── workflows/              # 6 core workflows (TDD, review, debug, research, deviation, execution-flow)
├── references/             # 8 reference docs (execution-loop, state-diagram, evidence-spec, etc.)
├── hooks/                  # Session lifecycle hooks
│   ├── gsd-auto-update.cjs   # Auto-update from GitHub Releases (24h check interval)
│   ├── gsd-context-monitor.cjs # Real-time context health monitoring
│   ├── gsd-session-init.cjs   # Session initialization + CLAUDE.md status injection
│   ├── gsd-session-stop.cjs   # Graceful shutdown with crash markers
│   ├── gsd-statusline.cjs     # StatusLine display (composite-aware)
│   └── lib/                   # Shared hook utilities (gsd-finder, composite statusline, semver)
├── tests/                  # 972 tests (unit + simulation + E2E integration)
├── cli.js                  # Install/uninstall CLI entry
├── install.js              # Installation script (plugin-aware, idempotent)
└── uninstall.js            # Uninstall script
```

## Testing

```bash
npm test                    # Run all 972 tests
npm run test:coverage       # Tests + coverage report (94%+ lines, 83%+ branches)
npm run lint                # Biome lint
node --test tests/file.js   # Run a single test file
```

## Documentation

- [Design Document v3.5](docs/gsd-lite-design.md) — Full architecture and protocol spec
- [Engineering Tasks](docs/gsd-lite-engineering-tasks.md) — 38 implementation tasks (5 phases, all complete)
- [Calibration Notes](docs/calibration-notes.md) — Context threshold and TTL calibration

## Requirements

- Node.js >= 20.0.0
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

## License

MIT
