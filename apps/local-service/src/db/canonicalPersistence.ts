import type Database from "better-sqlite3";

export type CanonicalTimelineItemType = "message" | "session_boundary" | "context_compaction";
export type CanonicalMessageKind = "user" | "assistant" | "assistant-continuation" | "running-guide" | "agent-run-terminal";

export type CanonicalTimelineItem = {
  flowId: string;
  channelId: string;
  itemId: string;
  position: number;
  itemType: CanonicalTimelineItemType;
  messageId: string | null;
  sessionId: string | null;
  agentRunId: string | null;
  presentationTurnId: string | null;
  messageKind: CanonicalMessageKind | null;
  lifecycle: "active" | "complete" | "sealed";
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CanonicalQueueItem = {
  id: string;
  flowId: string;
  position: number;
  status: "accepted" | "dispatching";
  revision: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CanonicalSubmission = {
  flowId: string;
  clientMessageId: string;
  submissionType: "normal" | "guide";
  payloadHash: string;
  payload: Record<string, unknown>;
  receiptState: "received" | "dispatching" | "materialized" | "rejected" | "cancelled" | "uncertain";
  messageId: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SubmissionAcceptance =
  | { outcome: "created"; submission: CanonicalSubmission }
  | { outcome: "duplicate"; submission: CanonicalSubmission }
  | { outcome: "conflict"; submission: CanonicalSubmission };

type CanonicalSubmissionRow = Omit<CanonicalSubmission, "payload"> & { payloadJson: string };

function now() {
  return new Date().toISOString();
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function submissionFromRow(row: CanonicalSubmissionRow): CanonicalSubmission {
  const { payloadJson, ...rest } = row;
  return {
    ...rest,
    submissionType: rest.submissionType === "guide" ? "guide" : "normal",
    receiptState: (["received", "dispatching", "materialized", "rejected", "cancelled", "uncertain"].includes(rest.receiptState)
      ? rest.receiptState
      : "uncertain") as CanonicalSubmission["receiptState"],
    payload: parseObject(payloadJson),
  };
}

export function createCanonicalPersistence(sqlite: Database.Database) {
  const api = {
    commitTimelineMutation(input: {
      flowId: string;
      channelId: string;
      sessionId: string;
      agentRunId: string;
      messages: Array<{ message: Record<string, unknown>; lifecycle: "active" | "complete" | "sealed" }>;
      removedMessageIds?: string[];
    }) {
      const timestamp = now();
      return sqlite.transaction(() => {
        const committedItemIds = new Set<string>();
        const channel = sqlite.prepare("SELECT cursor FROM chat_transcript_channels WHERE flow_id = ? AND channel_id = ?")
          .get(input.flowId, input.channelId) as { cursor: number } | undefined;
        const cursor = (channel?.cursor ?? 0) + 1;
        sqlite.prepare(`
          INSERT INTO chat_transcript_channels (flow_id, channel_id, cursor, revision, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(flow_id, channel_id) DO UPDATE SET
            cursor = excluded.cursor,
            revision = chat_transcript_channels.revision + 1,
            updated_at = excluded.updated_at
        `).run(input.flowId, input.channelId, cursor, timestamp);

        const selectExisting = sqlite.prepare(`
          SELECT position, session_id AS sessionId, agent_run_id AS agentRunId,
            presentation_turn_id AS presentationTurnId, message_kind AS messageKind,
            lifecycle, payload_json AS payloadJson, created_at AS createdAt
          FROM chat_timeline_items
          WHERE flow_id = ? AND channel_id = ? AND item_id = ? AND item_type = 'message'
        `);
        const selectNextPosition = sqlite.prepare(`
          SELECT COALESCE(MAX(position), 0) + 1 AS position
          FROM chat_timeline_items WHERE flow_id = ? AND channel_id = ?
        `);
        const upsert = sqlite.prepare(`
          INSERT INTO chat_timeline_items (
            flow_id, channel_id, item_id, position, item_type, message_id,
            session_id, agent_run_id, presentation_turn_id, message_kind,
            lifecycle, payload_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'message', ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(flow_id, channel_id, item_id) DO UPDATE SET
            session_id = excluded.session_id,
            agent_run_id = excluded.agent_run_id,
            presentation_turn_id = excluded.presentation_turn_id,
            message_kind = excluded.message_kind,
            lifecycle = excluded.lifecycle,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        `);
        const run = sqlite.prepare(`
          SELECT r.agent_session_id AS agentSessionId, r.created_at AS createdAt,
            s.display_name AS displayName
          FROM agent_runs r JOIN agent_sessions s ON s.id = r.agent_session_id
          WHERE r.id = ? AND r.flow_id = ?
        `).get(input.agentRunId, input.flowId) as {
          agentSessionId: string;
          displayName: string;
          createdAt: string;
        } | undefined;
        const hasRunMessage = sqlite.prepare(`
          SELECT 1 FROM chat_timeline_items
          WHERE flow_id = ? AND channel_id = ? AND item_type = 'message' AND agent_run_id = ? LIMIT 1
        `).get(input.flowId, input.channelId, input.agentRunId);
        const hasAnyMessage = sqlite.prepare(`
          SELECT 1 FROM chat_timeline_items
          WHERE flow_id = ? AND channel_id = ? AND item_type = 'message' LIMIT 1
        `).get(input.flowId, input.channelId);
        if (run && !hasRunMessage && hasAnyMessage) {
          const boundaryId = `session-boundary:${input.agentRunId}`;
          const position = (selectNextPosition.get(input.flowId, input.channelId) as { position: number }).position;
          sqlite.prepare(`
            INSERT OR IGNORE INTO chat_timeline_items (
              flow_id, channel_id, item_id, position, item_type, message_id,
              session_id, agent_run_id, presentation_turn_id, message_kind,
              lifecycle, payload_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'session_boundary', NULL, ?, ?, NULL, NULL, 'complete', ?, ?, ?)
          `).run(
            input.flowId,
            input.channelId,
            boundaryId,
            position,
            input.sessionId,
            input.agentRunId,
            JSON.stringify({
              agent_session_id: run.agentSessionId,
              agent_run_id: input.agentRunId,
              display_name: run.displayName,
              started_at: run.createdAt,
              status: "loaded",
            }),
            run.createdAt,
            timestamp,
          );
          committedItemIds.add(boundaryId);
        }

        for (const item of input.messages) {
          const messageId = typeof item.message.id === "string" ? item.message.id : "";
          if (!messageId) throw new Error("Canonical timeline message is missing an id");
          committedItemIds.add(messageId);
          const metadata = item.message.metadata && typeof item.message.metadata === "object"
            ? item.message.metadata as Record<string, unknown>
            : {};
          const role = item.message.role === "assistant" ? "assistant" : "user";
          const rawKind = typeof metadata.messageKind === "string" ? metadata.messageKind : role;
          const messageKind = rawKind === "agent-run-terminal" ? "agent-run-terminal" : rawKind;
          const presentationTurnId = typeof metadata.presentationTurnId === "string"
            ? metadata.presentationTurnId
            : role === "assistant" ? messageId : null;
          const existing = selectExisting.get(input.flowId, input.channelId, messageId) as {
            position: number;
            sessionId: string | null;
            agentRunId: string | null;
            presentationTurnId: string | null;
            messageKind: string | null;
            lifecycle: string;
            payloadJson: string;
            createdAt: string;
          } | undefined;
          const position = existing?.position
            ?? (selectNextPosition.get(input.flowId, input.channelId) as { position: number }).position;
          const createdAt = typeof item.message.createdAt === "string"
            ? item.message.createdAt
            : existing?.createdAt ?? timestamp;
          const payloadJson = JSON.stringify(item.message);
          if (
            existing?.sessionId === input.sessionId
            && existing.agentRunId === input.agentRunId
            && existing.presentationTurnId === presentationTurnId
            && existing.messageKind === messageKind
            && existing.lifecycle === item.lifecycle
            && existing.payloadJson === payloadJson
          ) continue;
          upsert.run(
            input.flowId,
            input.channelId,
            messageId,
            position,
            messageId,
            input.sessionId,
            input.agentRunId,
            presentationTurnId,
            messageKind,
            item.lifecycle,
            payloadJson,
            createdAt,
            timestamp,
          );
        }
        if (input.removedMessageIds?.length) {
          const remove = sqlite.prepare(`
            DELETE FROM chat_timeline_items
            WHERE flow_id = ? AND channel_id = ? AND item_type = 'message' AND message_id = ?
          `);
          for (const messageId of new Set(input.removedMessageIds)) remove.run(input.flowId, input.channelId, messageId);
        }
        return {
          cursor,
          timelineItems: api.listTimelineItems(input.flowId, input.channelId)
            .filter((item) => committedItemIds.has(item.itemId)),
        };
      })();
    },

    listTimelineItems(flowId: string, channelId: string): CanonicalTimelineItem[] {
      const rows = sqlite.prepare(`
        SELECT flow_id AS flowId, channel_id AS channelId, item_id AS itemId, position,
          item_type AS itemType, message_id AS messageId, session_id AS sessionId,
          agent_run_id AS agentRunId, presentation_turn_id AS presentationTurnId,
          message_kind AS messageKind, lifecycle, payload_json AS payloadJson,
          created_at AS createdAt, updated_at AS updatedAt
        FROM chat_timeline_items WHERE flow_id = ? AND channel_id = ? ORDER BY position ASC
      `).all(flowId, channelId) as Array<Omit<CanonicalTimelineItem, "payload" | "messageKind"> & { payloadJson: string; messageKind: string | null }>;
      return rows.map(({ payloadJson, ...row }) => ({
        ...row,
        itemType: row.itemType === "session_boundary"
          ? "session_boundary"
          : row.itemType === "context_compaction" ? "context_compaction" : "message",
        lifecycle: row.lifecycle === "active" ? "active" : row.lifecycle === "sealed" ? "sealed" : "complete",
        messageKind: (row.messageKind === "agent-run-terminal" ? "agent-run-terminal" : row.messageKind) as CanonicalMessageKind | null,
        payload: parseObject(payloadJson),
      }));
    },

    upsertContextCompactionTimelineItem(input: {
      flowId: string;
      channelId: string;
      agentRunId: string;
      payload: Record<string, unknown> & { started_at: string; status: string };
    }) {
      const timestamp = now();
      const itemId = `context-compaction:${input.agentRunId}:${input.payload.started_at}`;
      const lifecycle = input.payload.status === "running" ? "active" : "complete";
      return sqlite.transaction(() => {
        const cursor = api.getTranscriptCursor(input.flowId, input.channelId) + 1;
        sqlite.prepare(`
          INSERT INTO chat_transcript_channels (flow_id, channel_id, cursor, revision, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(flow_id, channel_id) DO UPDATE SET cursor = excluded.cursor,
            revision = chat_transcript_channels.revision + 1, updated_at = excluded.updated_at
        `).run(input.flowId, input.channelId, cursor, timestamp);
        const existing = sqlite.prepare(`
          SELECT position, created_at AS createdAt FROM chat_timeline_items
          WHERE flow_id = ? AND channel_id = ? AND item_id = ?
        `).get(input.flowId, input.channelId, itemId) as { position: number; createdAt: string } | undefined;
        const position = existing?.position ?? (sqlite.prepare(`
          SELECT COALESCE(MAX(position), 0) + 1 AS position FROM chat_timeline_items
          WHERE flow_id = ? AND channel_id = ?
        `).get(input.flowId, input.channelId) as { position: number }).position;
        const run = sqlite.prepare("SELECT agent_session_id AS agentSessionId FROM agent_runs WHERE id = ? AND flow_id = ?")
          .get(input.agentRunId, input.flowId) as { agentSessionId: string } | undefined;
        sqlite.prepare(`
          INSERT INTO chat_timeline_items (
            flow_id, channel_id, item_id, position, item_type, message_id,
            session_id, agent_run_id, presentation_turn_id, message_kind,
            lifecycle, payload_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'context_compaction', NULL, ?, ?, NULL, NULL, ?, ?, ?, ?)
          ON CONFLICT(flow_id, channel_id, item_id) DO UPDATE SET
            lifecycle = excluded.lifecycle, payload_json = excluded.payload_json, updated_at = excluded.updated_at
        `).run(
          input.flowId,
          input.channelId,
          itemId,
          position,
          run?.agentSessionId ?? input.channelId,
          input.agentRunId,
          lifecycle,
          JSON.stringify(input.payload),
          existing?.createdAt ?? input.payload.started_at,
          timestamp,
        );
        return { cursor, item: api.listTimelineItems(input.flowId, input.channelId).find((item) => item.itemId === itemId) };
      })();
    },

    sealActiveTranscriptMessages() {
      return sqlite.prepare("UPDATE chat_timeline_items SET lifecycle = 'sealed', updated_at = ? WHERE lifecycle = 'active'")
        .run(now()).changes;
    },

    getTranscriptCursor(flowId: string, channelId: string) {
      return (sqlite.prepare("SELECT cursor FROM chat_transcript_channels WHERE flow_id = ? AND channel_id = ?")
        .get(flowId, channelId) as { cursor: number } | undefined)?.cursor ?? 0;
    },

    renameTimelineSession(flowId: string, fromSessionId: string, toSessionId: string) {
      if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;
      sqlite.prepare("UPDATE chat_timeline_items SET session_id = ?, updated_at = ? WHERE flow_id = ? AND session_id = ?")
        .run(toSessionId, now(), flowId, fromSessionId);
    },

    clearTimeline(flowId: string, channelId?: string) {
      sqlite.transaction(() => {
        if (channelId) {
          sqlite.prepare("DELETE FROM chat_timeline_items WHERE flow_id = ? AND channel_id = ?").run(flowId, channelId);
          sqlite.prepare("DELETE FROM chat_transcript_channels WHERE flow_id = ? AND channel_id = ?").run(flowId, channelId);
        } else {
          sqlite.prepare("DELETE FROM chat_timeline_items WHERE flow_id = ?").run(flowId);
          sqlite.prepare("DELETE FROM chat_transcript_channels WHERE flow_id = ?").run(flowId);
        }
      })();
    },

    getSubmission(flowId: string, clientMessageId: string): CanonicalSubmission | undefined {
      const row = sqlite.prepare(`
        SELECT flow_id AS flowId, client_message_id AS clientMessageId,
          submission_type AS submissionType, payload_hash AS payloadHash,
          payload_json AS payloadJson, receipt_state AS receiptState,
          message_id AS messageId, last_error_code AS lastErrorCode,
          created_at AS createdAt, updated_at AS updatedAt
        FROM chat_submissions WHERE flow_id = ? AND client_message_id = ?
      `).get(flowId, clientMessageId) as CanonicalSubmissionRow | undefined;
      return row ? submissionFromRow(row) : undefined;
    },

    acceptSubmission(input: {
      flowId: string;
      clientMessageId: string;
      submissionType: "normal" | "guide";
      payloadHash: string;
      payload: Record<string, unknown>;
    }): SubmissionAcceptance {
      const timestamp = now();
      return sqlite.transaction(() => {
        const existing = api.getSubmission(input.flowId, input.clientMessageId);
        if (existing) return {
          outcome: existing.submissionType === input.submissionType && existing.payloadHash === input.payloadHash
            ? "duplicate"
            : "conflict",
          submission: existing,
        } as SubmissionAcceptance;
        sqlite.prepare(`
          INSERT INTO chat_submissions (
            flow_id, client_message_id, submission_type, payload_hash, payload_json,
            receipt_state, message_id, last_error_code, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'received', NULL, NULL, ?, ?)
        `).run(input.flowId, input.clientMessageId, input.submissionType, input.payloadHash, JSON.stringify(input.payload), timestamp, timestamp);
        return { outcome: "created", submission: api.getSubmission(input.flowId, input.clientMessageId)! } as SubmissionAcceptance;
      })();
    },

    markSubmissionMaterialized(flowId: string, clientMessageId: string, messageId: string) {
      return sqlite.prepare(`
        UPDATE chat_submissions SET receipt_state = 'materialized', message_id = ?, payload_json = '{}',
          last_error_code = NULL, updated_at = ? WHERE flow_id = ? AND client_message_id = ?
      `).run(messageId, now(), flowId, clientMessageId).changes > 0;
    },

    claimSubmission(flowId: string, clientMessageId: string) {
      return sqlite.prepare(`
        UPDATE chat_submissions SET receipt_state = 'dispatching', updated_at = ?
        WHERE flow_id = ? AND client_message_id = ? AND receipt_state = 'received'
      `).run(now(), flowId, clientMessageId).changes > 0;
    },

    releaseSubmission(flowId: string, clientMessageId: string) {
      return sqlite.prepare(`
        UPDATE chat_submissions SET receipt_state = 'received', updated_at = ?
        WHERE flow_id = ? AND client_message_id = ? AND receipt_state = 'dispatching'
      `).run(now(), flowId, clientMessageId).changes > 0;
    },

    markSubmissionRejected(flowId: string, clientMessageId: string, errorCode: string) {
      return sqlite.prepare(`
        UPDATE chat_submissions SET receipt_state = 'rejected', last_error_code = ?, updated_at = ?
        WHERE flow_id = ? AND client_message_id = ? AND receipt_state IN ('received', 'dispatching')
      `).run(errorCode, now(), flowId, clientMessageId).changes > 0;
    },

    recoverDanglingSubmissions() {
      const timestamp = now();
      return sqlite.transaction(() => {
        const materialized = sqlite.prepare(`
          UPDATE chat_submissions SET receipt_state = 'materialized', message_id = client_message_id,
            payload_json = '{}', last_error_code = NULL, updated_at = ?
          WHERE receipt_state = 'dispatching' AND EXISTS (
            SELECT 1 FROM chat_timeline_items WHERE chat_timeline_items.flow_id = chat_submissions.flow_id
              AND chat_timeline_items.item_type = 'message'
              AND chat_timeline_items.message_id = chat_submissions.client_message_id
          )
        `).run(timestamp).changes;
        const requeued = sqlite.prepare(`
          UPDATE chat_submissions SET receipt_state = 'received', last_error_code = NULL, updated_at = ?
          WHERE receipt_state = 'dispatching'
        `).run(timestamp).changes;
        return { materialized, requeued };
      })();
    },

    addQueuedMessage(input: { id: string; flowId: string; payloadHash: string; payload: Record<string, unknown> }) {
      const timestamp = now();
      return sqlite.transaction(() => {
        const existing = api.getSubmission(input.flowId, input.id);
        if (existing) {
          const acceptance: SubmissionAcceptance = {
            outcome: existing.submissionType === "normal" && existing.payloadHash === input.payloadHash ? "duplicate" : "conflict",
            submission: existing,
          };
          return { acceptance, item: api.getQueuedMessage(input.flowId, input.id) };
        }
        sqlite.prepare(`
          INSERT INTO chat_submissions (
            flow_id, client_message_id, submission_type, payload_hash, payload_json,
            receipt_state, message_id, last_error_code, created_at, updated_at
          ) VALUES (?, ?, 'normal', ?, ?, 'received', NULL, NULL, ?, ?)
        `).run(input.flowId, input.id, input.payloadHash, JSON.stringify(input.payload), timestamp, timestamp);
        const position = (sqlite.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM chat_queue_items WHERE flow_id = ?")
          .get(input.flowId) as { position: number }).position;
        sqlite.prepare(`
          INSERT INTO chat_queue_items (id, flow_id, position, status, revision, payload_json, created_at, updated_at)
          VALUES (?, ?, ?, 'accepted', 1, ?, ?, ?)
        `).run(input.id, input.flowId, position, JSON.stringify(input.payload), timestamp, timestamp);
        const acceptance: SubmissionAcceptance = { outcome: "created", submission: api.getSubmission(input.flowId, input.id)! };
        return { acceptance, item: api.getQueuedMessage(input.flowId, input.id) };
      })();
    },

    listQueuedMessages(flowId: string): CanonicalQueueItem[] {
      const rows = sqlite.prepare(`
        SELECT id, flow_id AS flowId, position, status, revision, payload_json AS payloadJson,
          created_at AS createdAt, updated_at AS updatedAt
        FROM chat_queue_items WHERE flow_id = ? ORDER BY position ASC
      `).all(flowId) as Array<Omit<CanonicalQueueItem, "payload"> & { payloadJson: string }>;
      return rows.map(({ payloadJson, ...row }) => ({
        ...row,
        status: row.status === "dispatching" ? "dispatching" : "accepted",
        payload: parseObject(payloadJson),
      }));
    },

    getQueuedMessage(flowId: string, queueId: string) {
      return api.listQueuedMessages(flowId).find((item) => item.id === queueId);
    },

    claimQueuedMessage(flowId: string, queueId?: string) {
      return sqlite.transaction(() => {
        const first = api.listQueuedMessages(flowId)[0];
        if (!first || first.status !== "accepted" || (queueId && first.id !== queueId)) return undefined;
        const updated = sqlite.prepare(`
          UPDATE chat_queue_items SET status = 'dispatching', revision = revision + 1, updated_at = ?
          WHERE flow_id = ? AND id = ? AND status = 'accepted' AND revision = ?
        `).run(now(), flowId, first.id, first.revision).changes;
        return updated ? api.getQueuedMessage(flowId, first.id) : undefined;
      })();
    },

    claimQueuedMessageForGuide(flowId: string, queueId: string) {
      return sqlite.transaction(() => {
        const item = api.getQueuedMessage(flowId, queueId);
        if (!item || item.status !== "accepted") return undefined;
        const updated = sqlite.prepare(`
          UPDATE chat_queue_items SET status = 'dispatching', revision = revision + 1, updated_at = ?
          WHERE flow_id = ? AND id = ? AND status = 'accepted' AND revision = ?
        `).run(now(), flowId, queueId, item.revision).changes;
        return updated ? api.getQueuedMessage(flowId, queueId) : undefined;
      })();
    },

    releaseQueuedMessage(flowId: string, queueId: string) {
      return sqlite.prepare(`
        UPDATE chat_queue_items SET status = 'accepted', revision = revision + 1, updated_at = ?
        WHERE flow_id = ? AND id = ? AND status = 'dispatching'
      `).run(now(), flowId, queueId).changes > 0;
    },

    completeQueuedMessage(flowId: string, queueId: string, messageId = queueId) {
      return sqlite.transaction(() => {
        const changed = sqlite.prepare("DELETE FROM chat_queue_items WHERE flow_id = ? AND id = ?").run(flowId, queueId).changes;
        api.markSubmissionMaterialized(flowId, queueId, messageId);
        return changed > 0;
      })();
    },

    completeGuidedQueuedMessage(flowId: string, queueId: string) {
      return sqlite.transaction(() => {
        const changed = sqlite.prepare("DELETE FROM chat_queue_items WHERE flow_id = ? AND id = ?").run(flowId, queueId).changes;
        sqlite.prepare("UPDATE chat_submissions SET receipt_state = 'cancelled', updated_at = ? WHERE flow_id = ? AND client_message_id = ?")
          .run(now(), flowId, queueId);
        return changed > 0;
      })();
    },

    markQueuedMessageUncertain(flowId: string, queueId: string) {
      return sqlite.transaction(() => {
        const changed = sqlite.prepare("DELETE FROM chat_queue_items WHERE flow_id = ? AND id = ?").run(flowId, queueId).changes;
        sqlite.prepare(`
          UPDATE chat_submissions SET receipt_state = 'uncertain', last_error_code = 'PROCESS_RESTART', updated_at = ?
          WHERE flow_id = ? AND client_message_id = ?
        `).run(now(), flowId, queueId);
        return changed > 0;
      })();
    },

    deleteQueuedMessage(flowId: string, queueId: string) {
      return sqlite.transaction(() => {
        const item = api.getQueuedMessage(flowId, queueId);
        if (!item || item.status !== "accepted") return false;
        const changed = sqlite.prepare("DELETE FROM chat_queue_items WHERE flow_id = ? AND id = ? AND status = 'accepted'")
          .run(flowId, queueId).changes;
        if (changed) sqlite.prepare(`
          UPDATE chat_submissions SET receipt_state = 'cancelled', updated_at = ?
          WHERE flow_id = ? AND client_message_id = ?
        `).run(now(), flowId, queueId);
        return changed > 0;
      })();
    },

    updateQueuedMessage(input: {
      flowId: string;
      queueId: string;
      expectedRevision: number;
      payloadHash: string;
      payload: Record<string, unknown>;
    }) {
      const timestamp = now();
      return sqlite.transaction(() => {
        const item = api.getQueuedMessage(input.flowId, input.queueId);
        if (!item || item.status !== "accepted" || item.revision !== input.expectedRevision) return undefined;
        const changed = sqlite.prepare(`
          UPDATE chat_queue_items SET payload_json = ?, revision = revision + 1, updated_at = ?
          WHERE flow_id = ? AND id = ? AND status = 'accepted' AND revision = ?
        `).run(
          JSON.stringify(input.payload), timestamp, input.flowId, input.queueId, input.expectedRevision,
        ).changes;
        if (!changed) return undefined;
        sqlite.prepare(`
          UPDATE chat_submissions SET payload_hash = ?, payload_json = ?, updated_at = ?
          WHERE flow_id = ? AND client_message_id = ? AND receipt_state = 'received'
        `).run(input.payloadHash, JSON.stringify(input.payload), timestamp, input.flowId, input.queueId);
        return api.getQueuedMessage(input.flowId, input.queueId);
      })();
    },

    clearQueuedMessages(flowId: string) {
      sqlite.transaction(() => {
        const ids = api.listQueuedMessages(flowId).filter((item) => item.status === "accepted").map((item) => item.id);
        sqlite.prepare("DELETE FROM chat_queue_items WHERE flow_id = ? AND status = 'accepted'").run(flowId);
        const cancel = sqlite.prepare(`
          UPDATE chat_submissions SET receipt_state = 'cancelled', updated_at = ?
          WHERE flow_id = ? AND client_message_id = ?
        `);
        const timestamp = now();
        for (const queueId of ids) cancel.run(timestamp, flowId, queueId);
      })();
    },

    reorderQueuedMessages(flowId: string, queueIds: string[]) {
      const existing = api.listQueuedMessages(flowId);
      if (existing.length !== queueIds.length || new Set(queueIds).size !== queueIds.length) return false;
      if (existing.some((item) => !queueIds.includes(item.id) || item.status !== "accepted")) return false;
      sqlite.transaction(() => {
        sqlite.prepare("UPDATE chat_queue_items SET position = -position WHERE flow_id = ?").run(flowId);
        const update = sqlite.prepare(`
          UPDATE chat_queue_items SET position = ?, revision = revision + 1, updated_at = ?
          WHERE flow_id = ? AND id = ? AND status = 'accepted'
        `);
        const timestamp = now();
        queueIds.forEach((queueId, index) => update.run(index + 1, timestamp, flowId, queueId));
      })();
      return true;
    },
  };
  return api;
}

export type CanonicalPersistence = ReturnType<typeof createCanonicalPersistence>;
