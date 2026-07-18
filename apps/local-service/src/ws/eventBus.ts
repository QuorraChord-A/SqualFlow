import { ServerWsMessageSchema, type ServerWsMessage } from "../protocol/wsMessages.js";

type Handler = (message: ServerWsMessage) => Promise<void> | void;

export class EventBus {
  private readonly subscriptions = new Map<string, Map<string, Handler>>();
  private readonly observers = new Map<string, Handler>();

  subscribeAll(observerId: string, handler: Handler): void {
    this.observers.set(observerId, handler);
  }

  unsubscribeAll(observerId: string): void {
    this.observers.delete(observerId);
  }

  subscribe(flowId: string, clientId: string, handler: Handler): void {
    const flowSubscriptions = this.subscriptions.get(flowId) ?? new Map<string, Handler>();
    flowSubscriptions.set(clientId, handler);
    this.subscriptions.set(flowId, flowSubscriptions);
  }

  unsubscribe(flowId: string, clientId: string): void {
    const flowSubscriptions = this.subscriptions.get(flowId);
    if (!flowSubscriptions) return;

    flowSubscriptions.delete(clientId);
    if (flowSubscriptions.size === 0) {
      this.subscriptions.delete(flowId);
    }
  }

  unsubscribeClient(clientId: string): void {
    for (const flowId of [...this.subscriptions.keys()]) {
      this.unsubscribe(flowId, clientId);
    }
  }

  async publish(flowId: string, message: ServerWsMessage): Promise<void> {
    const parsedMessage = ServerWsMessageSchema.parse(message);
    if ("flow_id" in parsedMessage && parsedMessage.flow_id !== flowId) {
      throw new Error(`Event flow_id mismatch: expected ${flowId}, got ${parsedMessage.flow_id}`);
    }

    const handlers = [
      ...(this.subscriptions.get(flowId)?.values() ?? []),
      ...this.observers.values(),
    ];

    await Promise.allSettled(handlers.map((handler) => Promise.resolve().then(() => handler(parsedMessage))));
  }
}
