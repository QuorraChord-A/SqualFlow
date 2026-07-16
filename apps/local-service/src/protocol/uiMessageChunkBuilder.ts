import type { UiMessageChunk } from "./uiMessageChunks.js";
import type { RuntimeCapability } from "../domain/runtimeCapabilities.js";

type ToolCallMetadata = {
  capability?: RuntimeCapability | null;
  providerToolName?: string | null;
};

export class UiMessageChunkBuilder {
  private eventSeq = 0;
  private blockSeq = 0;
  private textOpen: string | null = null;
  private reasoningOpen: string | null = null;

  constructor(
    private readonly messageId: string,
    private readonly startedAt = new Date().toISOString(),
  ) {}

  start(): UiMessageChunk {
    return { type: "start", messageId: this.messageId, seq: this.nextEventSeq(), startedAt: this.startedAt };
  }

  reasoningDelta(delta: string): UiMessageChunk[] {
    const chunks = this.closeText();
    if (!this.reasoningOpen) {
      this.reasoningOpen = this.nextBlockId();
      chunks.push({ type: "reasoning-start", messageId: this.messageId, seq: this.nextEventSeq(), id: this.reasoningOpen });
    }
    chunks.push({ type: "reasoning-delta", messageId: this.messageId, seq: this.nextEventSeq(), id: this.reasoningOpen, delta });
    return chunks;
  }

  textDelta(delta: string): UiMessageChunk[] {
    const chunks = this.closeReasoning();
    if (!this.textOpen) {
      this.textOpen = this.nextBlockId();
      chunks.push({ type: "text-start", messageId: this.messageId, seq: this.nextEventSeq(), id: this.textOpen });
    }
    chunks.push({ type: "text-delta", messageId: this.messageId, seq: this.nextEventSeq(), id: this.textOpen, delta });
    return chunks;
  }

  toolCall(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    metadata: ToolCallMetadata = {},
  ): UiMessageChunk[] {
    const inputText = JSON.stringify(input);
    return [
      ...this.toolCallStart(toolName, toolCallId, metadata),
      this.toolInputDelta(toolCallId, inputText),
      this.toolInputAvailable(toolName, toolCallId, input, metadata),
    ];
  }

  toolCallStart(
    toolName: string,
    toolCallId: string,
    metadata: ToolCallMetadata = {},
  ): UiMessageChunk[] {
    const chunks = this.closeAll();
    const identity = {
      toolName,
      ...(metadata.capability ? { capability: metadata.capability } : {}),
      ...(metadata.providerToolName ? { providerToolName: metadata.providerToolName } : {}),
    };
    chunks.push({ type: "tool-input-start", messageId: this.messageId, seq: this.nextEventSeq(), toolCallId, ...identity });
    return chunks;
  }

  toolInputDelta(toolCallId: string, inputTextDelta: string): UiMessageChunk {
    return { type: "tool-input-delta", messageId: this.messageId, seq: this.nextEventSeq(), toolCallId, inputTextDelta };
  }

  toolInputAvailable(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    metadata: ToolCallMetadata = {},
  ): UiMessageChunk {
    const identity = {
      toolName,
      ...(metadata.capability ? { capability: metadata.capability } : {}),
      ...(metadata.providerToolName ? { providerToolName: metadata.providerToolName } : {}),
    };
    return { type: "tool-input-available", messageId: this.messageId, seq: this.nextEventSeq(), toolCallId, ...identity, input };
  }

  toolResult(toolCallId: string, content: string, isError: boolean): UiMessageChunk {
    return {
      type: "tool-output-available",
      messageId: this.messageId,
      seq: this.nextEventSeq(),
      toolCallId,
      output: { content, is_error: isError },
    };
  }

  finish(durationMs: number | null, finishedAt = new Date().toISOString()): UiMessageChunk[] {
    return [...this.closeAll(), { type: "finish", messageId: this.messageId, seq: this.nextEventSeq(), durationMs, finishedAt }];
  }

  endAssistantMessage(): UiMessageChunk[] {
    return this.closeAll();
  }

  private nextEventSeq() {
    const seq = this.eventSeq;
    this.eventSeq += 1;
    return seq;
  }

  private nextBlockId() {
    this.blockSeq += 1;
    return `blk-${this.messageId}-${this.blockSeq}`;
  }

  private closeReasoning(): UiMessageChunk[] {
    if (!this.reasoningOpen) return [];
    const id = this.reasoningOpen;
    this.reasoningOpen = null;
    return [{ type: "reasoning-end", messageId: this.messageId, seq: this.nextEventSeq(), id }];
  }

  private closeText(): UiMessageChunk[] {
    if (!this.textOpen) return [];
    const id = this.textOpen;
    this.textOpen = null;
    return [{ type: "text-end", messageId: this.messageId, seq: this.nextEventSeq(), id }];
  }

  private closeAll(): UiMessageChunk[] {
    return [...this.closeReasoning(), ...this.closeText()];
  }
}
