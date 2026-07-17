import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildBaseOptions } from "../src/harness/baseHarness.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const probeWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-claude-probe-"));
process.once("exit", () => fs.rmSync(probeWorkspaceRoot, { recursive: true, force: true }));
const claudeSettingsPath = process.env.SQUADFLOW_CLAUDE_SETTINGS
  ?? path.join(repoRoot, "output", "settings", "claude.json");

type ProbeResult = {
  firstDone: boolean;
  secondDone: boolean;
  resultCount: number;
  error?: string;
};

function now() {
  return new Date().toISOString();
}

function log(scope: string, message: string) {
  console.log(`[${now()}] [${scope}] ${message}`);
}

function makeProbeServer(scope: string, onDelayStart?: () => void) {
  return createSdkMcpServer({
    name: "probe",
    version: "0.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        "delay",
        "Wait for a specified number of seconds before returning.",
        {
          seconds: z.number().int().min(1).max(20),
        },
        async ({ seconds }) => {
          onDelayStart?.();
          log(scope, `delay tool start: ${seconds}s`);
          await delay(seconds * 1000);
          log(scope, `delay tool end: ${seconds}s`);
          return {
            content: [{ type: "text", text: `delayed ${seconds} seconds` }],
          };
        },
        { alwaysLoad: true },
      ),
    ],
  });
}

function baseOptions(input: {
  sessionId?: string;
  resume?: string;
  scope: string;
  onDelayStart?: () => void;
}): Options {
  return buildBaseOptions({
    systemPrompt:
      "You are a deterministic SDK probe. Follow the user's requested output exactly. " +
      "When asked to use the delay tool, you must call mcp__probe__delay before answering.",
    cwd: probeWorkspaceRoot,
    allowedTools: ["mcp__probe__delay"],
    tools: [],
    disallowedTools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
    settingsPath: claudeSettingsPath,
    mcpServers: { probe: makeProbeServer(input.scope, input.onDelayStart) },
    canUseTool: async (_toolName, toolInput) => ({
      behavior: "allow",
      updatedInput: toolInput,
    }),
    maxTurns: 8,
    sessionId: input.sessionId,
    resume: input.resume,
  });
}

function userMessage(text: string, priority?: SDKUserMessage["priority"]): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    priority,
    timestamp: new Date().toISOString(),
  };
}

function summarizeText(message: SDKMessage): string {
  const raw = message as unknown as Record<string, unknown>;
  const type = String(raw.type ?? "unknown");

  if (type === "assistant") {
    const assistant = raw.message as { content?: Array<Record<string, unknown>> } | undefined;
    const blocks = assistant?.content ?? [];
    return blocks
      .map((block) => {
        if (block.type === "text") return `text:${String(block.text ?? "").slice(0, 120)}`;
        if (block.type === "tool_use") return `tool_use:${String(block.name ?? "")}`;
        return String(block.type ?? "block");
      })
      .join(" | ");
  }

  if (type === "result") {
    return `result:${String(raw.subtype ?? "")}`;
  }

  if (type === "system") {
    return `system:${String(raw.subtype ?? "")}`;
  }

  if (type === "user") {
    return "user";
  }

  if (type === "tool_progress") {
    return `tool_progress:${String(raw.tool_name ?? "")}:${String(raw.elapsed_time_seconds ?? "")}`;
  }

  return type;
}

async function consume(
  scope: string,
  iterable: AsyncIterable<SDKMessage>,
  onSecondDone?: () => void,
  onResult?: () => void,
): Promise<ProbeResult> {
  const result: ProbeResult = { firstDone: false, secondDone: false, resultCount: 0 };

  try {
    for await (const message of iterable) {
      const summary = summarizeText(message);
      log(scope, summary);
      if (summary.includes("FIRST_DONE")) result.firstDone = true;
      if (summary.includes("SECOND_DONE")) {
        result.secondDone = true;
        onSecondDone?.();
      }
      if (summary.startsWith("result:")) {
        result.resultCount += 1;
        onResult?.();
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log(scope, `ERROR: ${result.error}`);
  }

  return result;
}

async function runConcurrentResumeProbe() {
  const sessionId = randomUUID();
  log("resume", `sessionId=${sessionId}`);

  const firstPrompt =
    "Call mcp__probe__delay with seconds=8, then answer exactly FIRST_DONE. " +
    "Do not answer before the tool result.";
  const secondPrompt = "Answer exactly SECOND_DONE.";

  const q1 = query({
    prompt: firstPrompt,
    options: baseOptions({ sessionId, scope: "resume:q1" }),
  });
  const q1ResultPromise = consume("resume:q1", q1);

  await delay(2000);
  log("resume:q2", "starting resume query while q1 is still expected to be running");

  const q2 = query({
    prompt: secondPrompt,
    options: baseOptions({ resume: sessionId, scope: "resume:q2" }),
  });
  const q2ResultPromise = consume("resume:q2", q2);

  const [q1Result, q2Result] = await Promise.all([q1ResultPromise, q2ResultPromise]);
  log("resume", `summary=${JSON.stringify({ q1Result, q2Result })}`);
}

async function* streamingMessages(input: {
  delayStarted: Promise<void>;
  priority?: SDKUserMessage["priority"];
  holdOpenUntil?: Promise<void>;
  waitBeforeSecond?: Promise<void>;
  secondMessage?: string;
}): AsyncGenerator<SDKUserMessage> {
  yield userMessage(
    "Call mcp__probe__delay with seconds=8, then answer exactly FIRST_DONE. " +
      "Do not answer before the tool result.",
  );

  await (input.waitBeforeSecond ?? input.delayStarted);
  log("stream", "yielding second user message while the delay tool is running");
  yield userMessage(
    input.secondMessage ?? "After the first answer, answer exactly SECOND_DONE.",
    input.priority,
  );

  if (input.holdOpenUntil) {
    await Promise.race([input.holdOpenUntil, delay(30000)]);
  }
}

async function runStreamingInputProbe(input: {
  priority?: SDKUserMessage["priority"];
  holdOpen?: boolean;
  waitForFirstResult?: boolean;
  secondMessage?: string;
} = {}) {
  const sessionId = randomUUID();
  log("stream", `sessionId=${sessionId}`);
  let signalDelayStart!: () => void;
  const delayStarted = new Promise<void>((resolve) => {
    signalDelayStart = resolve;
  });
  let signalSecondDone!: () => void;
  const secondDone = new Promise<void>((resolve) => {
    signalSecondDone = resolve;
  });
  let signalFirstResult!: () => void;
  const firstResult = new Promise<void>((resolve) => {
    signalFirstResult = resolve;
  });

  const q = query({
    prompt: streamingMessages({
      delayStarted,
      priority: input.priority,
      holdOpenUntil: input.holdOpen ? secondDone : undefined,
      waitBeforeSecond: input.waitForFirstResult ? firstResult : undefined,
      secondMessage: input.secondMessage,
    }),
    options: baseOptions({ sessionId, scope: "stream", onDelayStart: signalDelayStart }),
  });

  const result = await consume("stream", q, signalSecondDone, signalFirstResult);
  log("stream", `summary=${JSON.stringify(result)}`);
}

const mode = process.argv[2] ?? "all";

if (mode === "resume" || mode === "all") {
  await runConcurrentResumeProbe();
}

if (mode === "stream" || mode === "all") {
  await runStreamingInputProbe();
}

if (mode === "stream-next") {
  await runStreamingInputProbe({ priority: "next" });
}

if (mode === "stream-next-open") {
  await runStreamingInputProbe({ priority: "next", holdOpen: true });
}

if (mode === "stream-later-open") {
  await runStreamingInputProbe({ priority: "later", holdOpen: true });
}

if (mode === "stream-later") {
  await runStreamingInputProbe({ priority: "later" });
}

if (mode === "stream-after-result") {
  await runStreamingInputProbe({ holdOpen: true, waitForFirstResult: true });
}

if (mode === "steer-now") {
  await runStreamingInputProbe({
    priority: "now",
    holdOpen: true,
    secondMessage: "Override the current instruction. After the delay tool returns, output exactly SECOND_DONE and do not output FIRST_DONE.",
  });
}

if (mode === "steer-next") {
  await runStreamingInputProbe({
    priority: "next",
    holdOpen: true,
    secondMessage: "Override the current instruction. After the delay tool returns, output exactly SECOND_DONE and do not output FIRST_DONE.",
  });
}
