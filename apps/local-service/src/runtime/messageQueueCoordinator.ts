import type { Store } from "../db/store.js";
import { errorDiagnostic } from "../observability/operationalLogger.js";
import type { OperationalLogger } from "../observability/operationalLogger.js";
import type { ServerWsMessage } from "../protocol/wsMessages.js";
import { drainNextQueuedMessage, type WsConnection } from "../server/wsGateway.js";
import type { EventBus } from "../ws/eventBus.js";

type QueueDrain = (flowId: string, connection: WsConnection) => Promise<boolean>;

export class MessageQueueCoordinator {
  private readonly drains = new Map<string, Promise<void>>();
  private started = false;

  constructor(private readonly deps: {
    store: Store;
    eventBus: EventBus;
    connectionForFlow: (flowId: string) => WsConnection;
    logger?: OperationalLogger;
    drain?: QueueDrain;
  }) {}

  start() {
    if (this.started) return { materialized: 0, requeued: 0 };
    this.started = true;
    this.deps.eventBus.subscribeAll("message-queue-coordinator", this.onEvent);

    const recovered = this.deps.store.recoverDanglingSubmissions();
    for (const flow of this.deps.store.listFlows()) {
      for (const queued of this.deps.store.listQueuedMessages(flow.id).filter((item) => item.status === "dispatching")) {
        const submission = this.deps.store.getSubmission(flow.id, queued.id);
        if (submission?.receiptState === "materialized") {
          this.deps.store.completeQueuedMessage(flow.id, queued.id, submission.messageId ?? queued.id);
        } else if (submission?.receiptState === "received") {
          this.deps.store.releaseQueuedMessage(flow.id, queued.id);
        } else {
          this.deps.store.markQueuedMessageUncertain(flow.id, queued.id);
        }
      }
      this.request(flow.id);
    }
    return recovered;
  }

  request = (flowId: string) => {
    if (!this.started || this.drains.has(flowId)) return;
    if (!this.deps.store.listQueuedMessages(flowId).some((item) => item.status === "accepted")) return;
    const drain = Promise.resolve()
      .then(() => (this.deps.drain ?? drainNextQueuedMessage)(flowId, this.deps.connectionForFlow(flowId)))
      .then(() => undefined)
      .catch((error) => {
        this.deps.logger?.error({
          event: "message_queue_drain_failed",
          flowId,
          ...errorDiagnostic(error),
        }, "failed to drain queued message");
      })
      .finally(() => {
        this.drains.delete(flowId);
      });
    this.drains.set(flowId, drain);
  };

  async close() {
    this.started = false;
    this.deps.eventBus.unsubscribeAll("message-queue-coordinator");
    await Promise.allSettled([...this.drains.values()]);
  }

  private readonly onEvent = (message: ServerWsMessage) => {
    if (message.type !== "user_turn:event") return;
    const status = (message.data as { status?: unknown } | null)?.status;
    if (["completed", "failed", "cancelled"].includes(String(status ?? ""))) {
      this.request(message.flow_id);
    }
  };
}
