# Task Runner MCP

MCP server that lets AI agents manage background processes.

## Problem

OpenClaw exec sessions have timeouts. Background processes spawned from agents get killed when sessions end. Agents need a proper way to start, monitor, and control long-running processes.

## Solution

A lightweight MCP server (~300 LOC) that:
- Spawns processes detached from parent
- Persists task state across server restarts
- Captures stdout/stderr to log files
- Provides tools for agents to manage tasks

## Tools

| Tool | Description |
|------|-------------|
| `task_start` | Start process → `{id, pid, status}` |
| `task_stop` | Kill task (SIGTERM → SIGKILL) |
| `task_signal` | Send specific signal (HUP, INT, etc.) |
| `task_status` | Get state + exit code + uptime |
| `task_logs` | Get stdout/stderr (tail, since) |
| `task_list` | List tasks, filter by tags |
| `task_write` | Write to stdin (for interactive) |
| `task_wait` | Block until exit or timeout |
| `task_prune` | Cleanup old stopped tasks |

## State Machine

```
pending → running → stopped (exit 0)
                  → failed (exit != 0)
                  → killed (signal)
                  → timeout
                  → lost (died while server down)
```

## File Structure

```
~/.task-runner/
├── state.json      # Task metadata
├── logs/{id}.log   # Combined stdout/stderr
└── pids/{id}.pid   # For orphan recovery
```

## Tech Stack

- **Language:** TypeScript (Node.js)
- **Protocol:** MCP (stdio transport)
- **Storage:** JSON file (state.json)
- **Target:** ~300 lines of code

## Security

```js
{
  maxConcurrentTasks: 20,
  maxLogSizeBytes: 10 * 1024 * 1024,
  allowedCwds: ['/home/user'],
  blockedEnvVars: ['AWS_SECRET_KEY', 'GITHUB_TOKEN']
}
```

## Status

🚧 **Planned** — Design complete, implementation pending.
