#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolResponse = { content: Array<{ type: "text"; text: string }> };
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type TaskState = "running" | "exited";

type LogItem = { t: number; stream: "stdout" | "stderr"; text: string };

type Task = {
  id: string;
  name?: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  createdAt: number;

  proc: ChildProcessWithoutNullStreams;
  pid: number;
  state: TaskState;
  exitCode: number | null;
  signal: NodeJS.Signals | null;

  maxLogBytes: number;
  logBytes: number;
  logs: LogItem[];

  waiters: Array<(t: Task) => void>;
};

const tasks = new Map<string, Task>();
const DEFAULT_MAX_LOG_BYTES = 1024 * 1024; // 1 MiB

const okText = (text: string): ToolResponse => ({ content: [{ type: "text", text }] });
const okJson = (v: unknown): ToolResponse => okText(JSON.stringify(v, null, 2));

function getTask(id: string): Task {
  const t = tasks.get(id);
  if (!t) throw new Error(`Task not found: ${id}`);
  return t;
}

function summary(t: Task) {
  return {
    id: t.id,
    name: t.name ?? null,
    command: t.command,
    args: t.args,
    cwd: t.cwd ?? null,
    pid: t.pid,
    state: t.state,
    exitCode: t.exitCode,
    signal: t.signal,
    createdAt: t.createdAt,
    logBytes: t.logBytes,
    maxLogBytes: t.maxLogBytes,
  };
}

function pushLog(task: Task, stream: "stdout" | "stderr", chunk: Buffer) {
  const text = chunk.toString("utf8");
  task.logs.push({ t: Date.now(), stream, text });
  task.logBytes += Buffer.byteLength(text, "utf8") + 16;
  while (task.logBytes > task.maxLogBytes && task.logs.length) {
    const old = task.logs.shift()!;
    task.logBytes -= Buffer.byteLength(old.text, "utf8") + 16;
  }
}

function formatLogs(items: LogItem[]) {
  return items
    .map((i) => `${new Date(i.t).toISOString()} [${i.stream}] ${i.text}`)
    .join("");
}

const server = new McpServer({ name: "task-runner-mcp", version: "0.1.0" });

server.tool(
  "task_start",
  {
    command: z.string().describe("Executable/command to run"),
    args: z.array(z.string()).default([]).describe("Arguments"),
    cwd: z.string().optional().describe("Working directory"),
    env: z.record(z.string()).optional().describe("Environment overrides"),
    name: z.string().optional().describe("Human-friendly name"),
    maxLogBytes: z
      .number()
      .int()
      .min(1024)
      .optional()
      .describe(`Max in-memory log bytes (default ${DEFAULT_MAX_LOG_BYTES})`),
  },
  async ({ command, args, cwd, env, name, maxLogBytes }) => {
    const id = randomUUID();
    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) } as NodeJS.ProcessEnv,
      stdio: "pipe",
    });
    if (!proc.pid) throw new Error("Failed to start process (no pid)");

    const task: Task = {
      id,
      name,
      command,
      args,
      cwd,
      env,
      createdAt: Date.now(),
      proc,
      pid: proc.pid,
      state: "running",
      exitCode: null,
      signal: null,
      maxLogBytes: maxLogBytes ?? DEFAULT_MAX_LOG_BYTES,
      logBytes: 0,
      logs: [],
      waiters: [],
    };

    proc.stdout.on("data", (b: Buffer) => pushLog(task, "stdout", b));
    proc.stderr.on("data", (b: Buffer) => pushLog(task, "stderr", b));

    proc.on("exit", (code, sig) => {
      task.state = "exited";
      task.exitCode = code;
      task.signal = (sig ?? null) as NodeJS.Signals | null;
      for (const w of task.waiters.splice(0)) w(task);
    });

    proc.on("error", (err) => pushLog(task, "stderr", Buffer.from(`Process error: ${String(err)}\n`)));

    tasks.set(id, task);
    return okJson({ id, pid: task.pid, state: task.state });
  }
);

server.tool(
  "task_status",
  { id: z.string().describe("Task id") },
  async ({ id }) => okJson(summary(getTask(id)))
);

server.tool("task_list", {}, async () => okJson({ tasks: Array.from(tasks.values()).map(summary) }));

server.tool(
  "task_logs",
  {
    id: z.string().describe("Task id"),
    offset: z.number().int().min(0).optional().describe("Log item offset (0-based)"),
    tail: z.number().int().min(0).optional().describe("Return last N log items"),
    includeTimestamps: z.boolean().optional().describe("Include ISO timestamps (default true)"),
  },
  async ({ id, offset, tail, includeTimestamps }) => {
    const t = getTask(id);
    const ts = includeTimestamps ?? true;
    let items = t.logs;
    if (tail !== undefined) items = items.slice(Math.max(0, items.length - tail));
    else if (offset !== undefined) items = items.slice(offset);
    const text = ts ? formatLogs(items) : items.map((i) => `[${i.stream}] ${i.text}`).join("");
    return okJson({
      id,
      state: t.state,
      pid: t.pid,
      exitCode: t.exitCode,
      signal: t.signal,
      logItemCount: t.logs.length,
      returnedCount: items.length,
      text,
    });
  }
);

server.tool(
  "task_write",
  {
    id: z.string().describe("Task id"),
    data: z.string().describe("Data to write to stdin"),
    addNewline: z.boolean().optional().describe("Append newline"),
  },
  async ({ id, data, addNewline }) => {
    const t = getTask(id);
    if (t.state !== "running") throw new Error("Task is not running");
    const payload = addNewline ? data + "\n" : data;
    await new Promise<void>((resolve, reject) => t.proc.stdin.write(payload, (e) => (e ? reject(e) : resolve())));
    return okText("ok");
  }
);

server.tool(
  "task_signal",
  {
    id: z.string().describe("Task id"),
    signal: z.string().describe("Signal (e.g. SIGTERM, SIGKILL, SIGINT)"),
  },
  async ({ id, signal }) => {
    const t = getTask(id);
    if (t.state !== "running") return okText("not running");
    const ok = t.proc.kill(signal as NodeJS.Signals);
    return okJson({ ok, id, pid: t.pid, signal });
  }
);

server.tool(
  "task_stop",
  {
    id: z.string().describe("Task id"),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Wait after SIGTERM before SIGKILL (default 5000ms)"),
  },
  async ({ id, timeoutMs }) => {
    const t = getTask(id);
    if (t.state !== "running") return okJson(summary(t));

    t.proc.kill("SIGTERM");

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => t.waiters.push(() => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs ?? 5000)),
    ]);

    if (!exited && t.state === "running") {
      t.proc.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolve) => t.waiters.push(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    }

    return okJson(summary(t));
  }
);

server.tool(
  "task_wait",
  {
    id: z.string().describe("Task id"),
    timeoutMs: z.number().int().min(0).optional().describe("Timeout ms (omit to wait indefinitely)"),
  },
  async ({ id, timeoutMs }) => {
    const t = getTask(id);
    if (t.state === "exited") return okJson(summary(t));
    const done = new Promise<Task>((resolve) => t.waiters.push(resolve));
    if (timeoutMs === undefined) return okJson(summary(await done));
    const res = await Promise.race([
      done,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return res === null ? okJson({ id, state: t.state, pid: t.pid, timeout: true }) : okJson(summary(res));
  }
);

server.tool(
  "task_prune",
  {
    includeRunning: z
      .boolean()
      .optional()
      .describe("If true, also remove running tasks from registry (does NOT stop them)")
  },
  async ({ includeRunning }) => {
    let removed = 0;
    for (const [id, t] of tasks) {
      if (t.state === "exited" || includeRunning) {
        tasks.delete(id);
        removed++;
      }
    }
    return okJson({ removed, remaining: tasks.size });
  }
);

async function main() {
  const transport = new StdioServerTransport();

  const shutdown = () => {
    for (const t of tasks.values()) {
      if (t.state === "running") {
        try {
          t.proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
