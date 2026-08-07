import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UiMessageChunk } from "../src/protocol/uiMessageChunks.js";
import type { RuntimeEvent } from "../src/runtime/runtimeEvents.js";
import {
  WorkRunToolAttributor,
  WorkspaceMutationCoordinator,
} from "../src/runtime/workRunFileAttribution.js";

const roots: string[] = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-attribution-"));
  roots.push(root);
  return root;
}

function other(raw: unknown = {}): RuntimeEvent {
  return { type: "other", raw };
}

function toolInput(input: {
  id: string;
  toolName: string;
  providerToolName: string;
  capability: "write" | "edit" | "shell";
  value: Record<string, unknown>;
}): UiMessageChunk {
  return {
    type: "tool-input-available",
    messageId: "msg-test",
    seq: 1,
    toolCallId: input.id,
    toolName: input.toolName,
    providerToolName: input.providerToolName,
    capability: input.capability,
    input: input.value,
  };
}

function toolOutput(id: string): UiMessageChunk {
  return {
    type: "tool-output-available",
    messageId: "msg-test",
    seq: 2,
    toolCallId: id,
    output: { content: "done", is_error: false },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("WorkRunToolAttributor", () => {
  it("keeps a Shell change while excluding another Flow's exact file change", async () => {
    const root = tempRoot();
    const coordinator = new WorkspaceMutationCoordinator();
    const flowA = new WorkRunToolAttributor(coordinator, {
      rootPath: root,
      ownerKey: "work-run-a",
      agentSessionId: "agent-a",
    });
    const flowB = new WorkRunToolAttributor(coordinator, {
      rootPath: root,
      ownerKey: "work-run-b",
      agentSessionId: "agent-b",
    });

    await flowA.observe(other(), [toolInput({
      id: "bash-a",
      toolName: "Bash",
      providerToolName: "Bash",
      capability: "shell",
      value: { command: "write a.md" },
    })]);
    await flowB.observe(other(), [toolInput({
      id: "write-b",
      toolName: "Write",
      providerToolName: "Write",
      capability: "write",
      value: { file_path: path.join(root, "b.md") },
    })]);
    fs.writeFileSync(path.join(root, "a.md"), "A\n", "utf8");
    fs.writeFileSync(path.join(root, "b.md"), "B\n", "utf8");
    await flowB.observe(other(), [toolOutput("write-b")]);
    await flowA.observe(other(), [toolOutput("bash-a")]);

    expect(await flowA.finish()).toEqual({ files: [{ path: "a.md", source: "shell" }] });
    expect(await flowB.finish()).toEqual({ files: [{ path: "b.md", source: "write" }] });
  });

  it("marks overlapping Shell windows from different Flows as unowned", async () => {
    const root = tempRoot();
    const coordinator = new WorkspaceMutationCoordinator();
    const flowA = new WorkRunToolAttributor(coordinator, {
      rootPath: root,
      ownerKey: "work-run-a",
      agentSessionId: "agent-a",
    });
    const flowB = new WorkRunToolAttributor(coordinator, {
      rootPath: root,
      ownerKey: "work-run-b",
      agentSessionId: "agent-b",
    });
    const shell = (id: string) => toolInput({
      id,
      toolName: "Bash",
      providerToolName: "Bash",
      capability: "shell",
      value: { command: id },
    });

    await flowA.observe(other(), [shell("bash-a")]);
    await flowB.observe(other(), [shell("bash-b")]);
    fs.writeFileSync(path.join(root, "a.md"), "A\n", "utf8");
    fs.writeFileSync(path.join(root, "b.md"), "B\n", "utf8");
    await flowA.observe(other(), [toolOutput("bash-a")]);
    await flowB.observe(other(), [toolOutput("bash-b")]);

    const summaryA = await flowA.finish();
    const summaryB = await flowB.finish();
    expect(summaryA.files).toEqual([]);
    expect(summaryB.files).toEqual([]);
    expect(summaryA.partialReason).toContain("Shell 文件操作时间重叠");
    expect(summaryB.partialReason).toContain("Shell 文件操作时间重叠");
  });

  it("waits for Codex item/completed instead of closing on output deltas", async () => {
    const root = tempRoot();
    const attributor = new WorkRunToolAttributor(new WorkspaceMutationCoordinator(), {
      rootPath: root,
      ownerKey: "work-run-codex",
      agentSessionId: "agent-codex",
    });
    await attributor.observe(other(), [toolInput({
      id: "command-1",
      toolName: "codex_command",
      providerToolName: "commandExecution",
      capability: "shell",
      value: { command: "write files" },
    })]);
    fs.writeFileSync(path.join(root, "first.md"), "first\n", "utf8");
    await attributor.observe(other({ method: "item/commandExecution/outputDelta" }), [toolOutput("command-1")]);
    fs.writeFileSync(path.join(root, "second.md"), "second\n", "utf8");
    await attributor.observe(other({
      method: "item/completed",
      params: { item: { id: "command-1", type: "commandExecution", status: "completed" } },
    }), [toolOutput("command-1")]);

    expect(await attributor.finish()).toEqual({
      files: [
        { path: "first.md", source: "shell" },
        { path: "second.md", source: "shell" },
      ],
    });
  });
});
