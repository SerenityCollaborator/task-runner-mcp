# task-runner-mcp

An **MCP server** that lets AI agents start/stop and interact with long-running background processes (dev servers, builds, scripts) that should persist beyond short exec timeouts.

## Install / Build

```bash
npm install
npm run build
```

## Run

This server speaks MCP over stdio:

```bash
node dist/index.js
```

## Tools

- `task_start` — start a new task via `spawn()` (command, args, cwd, env, name, maxLogBytes)
- `task_stop` — stop a task (SIGTERM then SIGKILL after timeout)
- `task_signal` — send arbitrary signal
- `task_status` — get status (running/exited, exit code, pid)
- `task_logs` — get logs (stdout/stderr combined) with `offset`, `tail` options
- `task_list` — list tasks
- `task_write` — write to stdin (for interactive processes)
- `task_wait` — wait until exit (with timeout)
- `task_prune` — remove exited tasks from memory

## Notes

- Logs are kept **in memory** per task, bounded by `maxLogBytes` (default: 1 MiB).
- `task_logs` returns combined output with simple `[stdout]` / `[stderr]` prefixes.
