import type { UIMessage } from "ai";
import type { TranscriptTimelineItem } from "../../../lib/ws";
import { describe, expect, it } from "vitest";
import { emptyTranscriptState, transcriptReducer, type TranscriptEvent, type TranscriptState } from "./transcriptState";

function textMessage(id: string, role: "user" | "assistant", text: string, metadata?: Record<string, unknown>): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    content: text,
    ...(metadata ? { metadata } : {}),
  } as UIMessage;
}

function apply(state: TranscriptState, cursor: number, event: TranscriptEvent): TranscriptState {
  const messageId = "messageId" in event ? event.messageId : null;
  const activeTurn = state.activeTurn && messageId
    ? {
        message_id: messageId,
        presentation_turn_id: state.activeTurn.presentationTurnId,
        segment_index: messageId === state.activeTurn.renderMessageId
          ? state.activeTurn.segmentIndex
          : state.activeTurn.segmentIndex + 1,
        started_at: state.activeTurn.timing.startedAt ?? "2026-06-29T00:00:00.000Z",
      }
    : undefined;
  return transcriptReducer(state, {
    type: "apply-events",
    events: [{
      streamEpoch: "epoch-1",
      cursor,
      timelineItems: event.type === "message-added" ? canonicalItems([event.message]) : [],
      event,
      ...(activeTurn ? { activeTurn } : {}),
    }],
  });
}

function canonicalItems(messages: UIMessage[]): TranscriptTimelineItem[] {
  return messages.map((message, index) => {
    const metadata = message.metadata && typeof message.metadata === "object"
      ? message.metadata as Record<string, unknown>
      : {};
    const runningGuide = metadata.messageKind === "running-guide";
    const inferredRoot = message.id.includes(":guide-") ? message.id.slice(0, message.id.indexOf(":guide-")) : null;
    const presentationTurnId = typeof metadata.presentationTurnId === "string"
      ? metadata.presentationTurnId
      : runningGuide ? inferredRoot : message.role === "assistant" ? inferredRoot ?? message.id : null;
    const kind = runningGuide
      ? "running-guide"
      : message.role === "assistant" ? inferredRoot ? "assistant-continuation" : "assistant" : "user";
    return {
      id: message.id,
      position: index + 1,
      type: "message",
      lifecycle: "complete",
      message_id: message.id,
      session_id: null,
      agent_run_id: null,
      work_run_id: null,
      presentation_turn_id: presentationTurnId,
      message_kind: kind,
      payload: {
        ...message,
        metadata: { ...metadata, messageKind: kind, ...(presentationTurnId ? { presentationTurnId } : {}) },
      },
      created_at: "2026-06-29T00:00:00.000Z",
      updated_at: "2026-06-29T00:00:00.000Z",
    };
  });
}

function messageText(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("");
}

describe("transcriptReducer guide boundaries", () => {
  it("requests a canonical snapshot when committed transcript cursors have a gap", () => {
    let state = transcriptReducer(emptyTranscriptState, {
      type: "load-snapshot",
      streamEpoch: "epoch-1",
      cursor: 5,
      timelineItems: canonicalItems([textMessage("msg-current", "user", "当前内容")]),
    });

    state = apply(state, 7, {
      type: "message-added",
      message: textMessage("msg-after-gap", "assistant", "断档后的内容"),
    });

    expect(state.cursor).toBe(5);
    expect(state.pendingEvents.has(7)).toBe(true);
    expect(state.needsResync).toBe(true);
    expect(state.messages.map((message) => message.id)).toEqual(["msg-current"]);
  });

  it("does not request a snapshot for contiguous committed transcript cursors", () => {
    let state = transcriptReducer(emptyTranscriptState, {
      type: "load-snapshot",
      streamEpoch: "epoch-1",
      cursor: 5,
      timelineItems: canonicalItems([textMessage("msg-current", "user", "当前内容")]),
    });

    state = apply(state, 6, {
      type: "message-added",
      message: textMessage("msg-next", "assistant", "连续内容"),
    });

    expect(state.cursor).toBe(6);
    expect(state.pendingEvents.size).toBe(0);
    expect(state.needsResync).toBe(false);
    expect(state.messages.map((message) => message.id)).toEqual(["msg-current", "msg-next"]);
  });

  it("uses the committed TimelineItem payload and position as the realtime authority", () => {
    let state = transcriptReducer(emptyTranscriptState, {
      type: "load-snapshot",
      streamEpoch: "epoch-1",
      cursor: 1,
      timelineItems: canonicalItems([textMessage("msg-user", "user", "开始")]),
    });
    const committed = canonicalItems([textMessage("msg-assistant", "assistant", "数据库正文")])[0]!;
    state = transcriptReducer(state, {
      type: "apply-events",
      events: [{
        streamEpoch: "epoch-1",
        cursor: 2,
        timelineItems: [{ ...committed, position: 2 }],
        event: {
          type: "message-added",
          message: textMessage("msg-assistant", "assistant", "事件临时正文"),
        },
      }],
    });

    expect(messageText(state.messages.find((message) => message.id === "msg-assistant"))).toBe("数据库正文");
    expect(state.timelineItems.find((item) => item.id === "msg-assistant")?.position).toBe(2);
  });

  it("removes rejected optimistic messages but keeps the same id after a canonical commit", () => {
    const optimistic = textMessage("msg-user-1", "user", "待确认");
    let state = transcriptReducer(emptyTranscriptState, { type: "sync-optimistic", messages: [optimistic] });
    expect(state.messages.map((message) => message.id)).toEqual(["msg-user-1"]);

    state = transcriptReducer(state, { type: "sync-optimistic", messages: [] });
    expect(state.messages).toEqual([]);

    state = transcriptReducer(state, { type: "sync-optimistic", messages: [optimistic] });
    state = transcriptReducer(state, {
      type: "load-snapshot",
      streamEpoch: "epoch-1",
      cursor: 0,
      timelineItems: [],
    });
    state = apply(state, 1, { type: "message-added", message: textMessage("msg-user-1", "user", "待确认") });
    state = transcriptReducer(state, { type: "sync-optimistic", messages: [] });
    expect(state.messages.map((message) => message.id)).toEqual(["msg-user-1"]);
  });

  it("removes an empty assistant placeholder and moves activity after an immediate Guide", () => {
    let state = transcriptReducer(emptyTranscriptState, {
      type: "load-snapshot",
      streamEpoch: "epoch-1",
      cursor: 0,
      timelineItems: [],
    });
    state = apply(state, 1, {
      type: "turn-started",
      messageId: "msg-assistant-1",
      startedAt: "2026-06-29T00:00:00.000Z",
    });
    state = transcriptReducer(state, {
      type: "apply-events",
      events: [{
        streamEpoch: "epoch-1",
        cursor: 2,
        timelineItems: canonicalItems([
          textMessage("msg-guide-1", "user", "立刻改方向", { messageKind: "running-guide", presentationTurnId: "msg-assistant-1" }),
        ]),
        event: {
          type: "message-added",
          message: textMessage("msg-guide-1", "user", "立刻改方向", { messageKind: "running-guide", presentationTurnId: "msg-assistant-1" }),
        },
        removedMessageIds: ["msg-assistant-1"],
        activeTurn: {
          message_id: "msg-assistant-1:guide-1",
          presentation_turn_id: "msg-assistant-1",
          segment_index: 1,
          started_at: "2026-06-29T00:00:00.000Z",
        },
      }],
    });

    expect(state.messages.map((message) => message.id)).toEqual([
      "msg-guide-1",
      "msg-assistant-1:guide-1",
    ]);
    expect(state.activeTurn?.renderMessageId).toBe("msg-assistant-1:guide-1");
  });

  it("ignores delayed transcript events from an older backend process", () => {
    let state = transcriptReducer(emptyTranscriptState, {
      type: "load-snapshot",
      streamEpoch: "epoch-new",
      cursor: 5,
      timelineItems: canonicalItems([textMessage("msg-current", "user", "当前内容")]),
    });
    state = transcriptReducer(state, {
      type: "apply-events",
      events: [{
        streamEpoch: "epoch-old",
        cursor: 6,
        timelineItems: canonicalItems([textMessage("msg-old", "user", "旧进程内容")]),
        event: { type: "message-added", message: textMessage("msg-old", "user", "旧进程内容") },
      }],
    });
    expect(state.messages.map((message) => message.id)).toEqual(["msg-current"]);
    expect(state.cursor).toBe(5);

    state = transcriptReducer(state, {
      type: "apply-events",
      events: [{
        streamEpoch: "epoch-new",
        cursor: 6,
        timelineItems: canonicalItems([textMessage("msg-next", "user", "新进程内容")]),
        event: { type: "message-added", message: textMessage("msg-next", "user", "新进程内容") },
      }],
    });
    expect(state.messages.map((message) => message.id)).toEqual(["msg-current", "msg-next"]);
  });

  it("renders committed Guide input and backend-provided continuation ids in order", () => {
    let state = transcriptReducer(emptyTranscriptState, {
      type: "load-snapshot",
      streamEpoch: "epoch-1",
      cursor: 0,
      timelineItems: [],
    });

    state = apply(state, 1, { type: "message-added", message: textMessage("msg-user-1", "user", "初始需求") });
    state = apply(state, 2, { type: "turn-started", messageId: "msg-assistant-1", startedAt: "2026-06-29T00:00:00.000Z" });
    state = apply(state, 3, { type: "text-start", messageId: "msg-assistant-1", id: "text-before" });
    state = apply(state, 4, { type: "text-delta", messageId: "msg-assistant-1", id: "text-before", delta: "引导前输出" });
    state = apply(state, 5, {
      type: "message-added",
      message: textMessage("msg-guide-1", "user", "补充引导", {
        messageKind: "running-guide",
        presentationTurnId: "msg-assistant-1",
        guideStatusLabel: "已引导对话",
      }),
    });

    expect(state.messages.map((message) => `${message.role}:${message.id}:${messageText(message)}`)).toEqual([
      "user:msg-user-1:初始需求",
      "assistant:msg-assistant-1:引导前输出",
      "user:msg-guide-1:补充引导",
    ]);
    expect((state.messages[2] as { metadata?: { guideStatusLabel?: string } }).metadata?.guideStatusLabel).toBe("已引导对话");

    state = apply(state, 6, { type: "text-start", messageId: "msg-assistant-1:guide-1", id: "text-after" });
    state = apply(state, 7, { type: "text-delta", messageId: "msg-assistant-1:guide-1", id: "text-after", delta: "引导后输出" });

    expect(state.messages.map((message) => `${message.role}:${message.id}:${messageText(message)}`)).toEqual([
      "user:msg-user-1:初始需求",
      "assistant:msg-assistant-1:引导前输出",
      "user:msg-guide-1:补充引导",
      "assistant:msg-assistant-1:guide-1:引导后输出",
    ]);
    expect((state.messages[2] as { metadata?: { guideStatusLabel?: string } }).metadata?.guideStatusLabel).toBe("已引导对话");
  });

  it("creates a new assistant segment after each running guide message", () => {
    let state = transcriptReducer(emptyTranscriptState, {
      type: "load-snapshot",
      streamEpoch: "epoch-1",
      cursor: 0,
      timelineItems: [],
    });

    state = apply(state, 1, { type: "message-added", message: textMessage("msg-user-1", "user", "初始需求") });
    state = apply(state, 2, { type: "turn-started", messageId: "msg-assistant-1", startedAt: "2026-06-29T00:00:00.000Z" });
    state = apply(state, 3, { type: "text-start", messageId: "msg-assistant-1", id: "text-before" });
    state = apply(state, 4, { type: "text-delta", messageId: "msg-assistant-1", id: "text-before", delta: "第一段" });
    state = apply(state, 5, {
      type: "message-added",
      message: textMessage("msg-guide-1", "user", "15遍吧", { messageKind: "running-guide", presentationTurnId: "msg-assistant-1" }),
    });
    state = apply(state, 6, { type: "text-start", messageId: "msg-assistant-1:guide-1", id: "text-after-guide-1" });
    state = apply(state, 7, { type: "text-delta", messageId: "msg-assistant-1:guide-1", id: "text-after-guide-1", delta: "第二段" });
    state = apply(state, 8, {
      type: "message-added",
      message: textMessage("msg-guide-2", "user", "18遍吧", { messageKind: "running-guide", presentationTurnId: "msg-assistant-1" }),
    });
    state = apply(state, 9, { type: "text-start", messageId: "msg-assistant-1:guide-2", id: "text-after-guide-2" });
    state = apply(state, 10, { type: "text-delta", messageId: "msg-assistant-1:guide-2", id: "text-after-guide-2", delta: "第三段" });

    expect(state.messages.map((message) => `${message.role}:${message.id}:${messageText(message)}`)).toEqual([
      "user:msg-user-1:初始需求",
      "assistant:msg-assistant-1:第一段",
      "user:msg-guide-1:15遍吧",
      "assistant:msg-assistant-1:guide-1:第二段",
      "user:msg-guide-2:18遍吧",
      "assistant:msg-assistant-1:guide-2:第三段",
    ]);
    expect((state.messages[2] as { metadata?: { guideStatusLabel?: string } }).metadata?.guideStatusLabel).toBe("已引导对话");
    expect((state.messages[4] as { metadata?: { guideStatusLabel?: string } }).metadata?.guideStatusLabel).toBe("已引导对话");
  });

  it("continues the original assistant identity after reconnecting inside a guided segment", () => {
    let state = transcriptReducer(emptyTranscriptState, {
      type: "load-snapshot",
      streamEpoch: "epoch-1",
      cursor: 20,
      timelineItems: canonicalItems([
        textMessage("msg-assistant-1", "assistant", "第一段"),
        textMessage("msg-guide-1", "user", "第一次引导", { messageKind: "running-guide", presentationTurnId: "msg-assistant-1" }),
        textMessage("msg-assistant-1:guide-1", "assistant", "第二段"),
      ]),
      activeTurn: {
        message_id: "msg-assistant-1:guide-1",
        presentation_turn_id: "msg-assistant-1",
        segment_index: 1,
        started_at: "2026-06-29T00:00:00.000Z",
      },
    });

    state = apply(state, 21, {
      type: "message-added",
      message: textMessage("msg-guide-2", "user", "第二次引导", { messageKind: "running-guide", presentationTurnId: "msg-assistant-1" }),
    });
    state = apply(state, 22, {
      type: "text-delta",
      messageId: "msg-assistant-1:guide-2",
      id: "text-after-reconnect",
      delta: "第三段",
    });

    expect(state.needsResync).toBe(false);
    expect(state.messages.map((message) => `${message.role}:${message.id}:${messageText(message)}`)).toEqual([
      "assistant:msg-assistant-1:第一段",
      "user:msg-guide-1:第一次引导",
      "assistant:msg-assistant-1:guide-1:第二段",
      "user:msg-guide-2:第二次引导",
      "assistant:msg-assistant-1:guide-2:第三段",
    ]);
  });

  it("uses backend-provided guide segment ids for live reasoning, tool, and final text", () => {
    let state = transcriptReducer(emptyTranscriptState, {
      type: "load-snapshot",
      streamEpoch: "epoch-1",
      cursor: 0,
      timelineItems: [],
    });

    state = apply(state, 1, { type: "message-added", message: textMessage("msg-user-1", "user", "初始需求") });
    state = apply(state, 2, { type: "turn-started", messageId: "msg-assistant-1", startedAt: "2026-06-29T00:00:00.000Z" });
    state = apply(state, 3, { type: "text-start", messageId: "msg-assistant-1", id: "text-before" });
    state = apply(state, 4, { type: "text-delta", messageId: "msg-assistant-1", id: "text-before", delta: "引导前输出" });
    state = apply(state, 5, {
      type: "message-added",
      message: textMessage("msg-guide-1", "user", "停止", { messageKind: "running-guide", presentationTurnId: "msg-assistant-1" }),
    });
    state = apply(state, 6, { type: "reasoning-start", messageId: "msg-assistant-1:guide-1", id: "reason-after-guide" });
    state = apply(state, 7, { type: "reasoning-delta", messageId: "msg-assistant-1:guide-1", id: "reason-after-guide", delta: "收到停止。" });
    state = apply(state, 8, {
      type: "tool-input-start",
      messageId: "msg-assistant-1:guide-1",
      toolCallId: "tool-1",
      toolName: "mcp__leader__get_context",
    });
    state = apply(state, 9, {
      type: "tool-output-available",
      messageId: "msg-assistant-1:guide-1",
      toolCallId: "tool-1",
      output: { content: "ok", is_error: false },
    });
    state = apply(state, 10, { type: "text-start", messageId: "msg-assistant-1:guide-1", id: "text-final" });
    state = apply(state, 11, { type: "text-delta", messageId: "msg-assistant-1:guide-1", id: "text-final", delta: "最终总结" });
    state = apply(state, 12, {
      type: "turn-finished",
      messageId: "msg-assistant-1:guide-1",
      durationMs: 30_000,
      finishedAt: "2026-06-29T00:00:30.000Z",
    });

    expect(state.needsResync).toBe(false);
    expect(state.messages.map((message) => `${message.role}:${message.id}:${messageText(message)}`)).toEqual([
      "user:msg-user-1:初始需求",
      "assistant:msg-assistant-1:引导前输出",
      "user:msg-guide-1:停止",
      "assistant:msg-assistant-1:guide-1:最终总结",
    ]);
    expect((state.messages[2] as { metadata?: { guideStatusLabel?: string } }).metadata?.guideStatusLabel).toBe("已引导对话");
  });
});
