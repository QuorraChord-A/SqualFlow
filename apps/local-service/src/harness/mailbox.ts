export type Mail = {
  flowId: string;
  runId: string;
  sender: string;
  to: string;
  type: string;
  content: unknown;
  logId?: string;
};

export type MailHandler = (mail: Mail) => Promise<void> | void;

type MailWaiter = {
  resolve: (mail: Mail) => void;
  reject: (error: Error) => void;
};

export class FlowMailbox {
  readonly flowId: string;
  readonly runId: string;

  private queue: Mail[] = [];
  private handlers = new Map<string, Set<MailHandler>>();
  private waiters = new Map<string, MailWaiter[]>();

  constructor(flowId: string, runId = "") {
    this.flowId = flowId;
    this.runId = runId;
  }

  send(mail: Mail): void {
    this.queue.push(mail);

    this.resolveNextWaiter(mail.to);

    for (const handler of this.handlers.get(mail.to) ?? []) {
      void Promise.resolve(handler(mail)).catch(() => undefined);
    }
  }

  subscribe(to: string, handler: MailHandler): void {
    const handlers = this.handlers.get(to) ?? new Set<MailHandler>();
    handlers.add(handler);
    this.handlers.set(to, handlers);
  }

  async wait(to: string): Promise<Mail> {
    const queued = this.pullOne(to);
    if (queued) {
      return queued;
    }

    return new Promise<Mail>((resolve, reject) => {
      const waiters = this.waiters.get(to) ?? [];
      waiters.push({ resolve, reject });
      this.waiters.set(to, waiters);
    });
  }

  pull(to: string): Mail[] {
    const pulled = this.queue.filter((mail) => mail.to === to);
    this.queue = this.queue.filter((mail) => mail.to !== to);
    return pulled;
  }

  has(to: string): boolean {
    return this.queue.some((mail) => mail.to === to);
  }

  clear(): void {
    const waiters = [...this.waiters.values()].flat();
    this.queue = [];
    this.handlers.clear();
    this.waiters.clear();
    for (const waiter of waiters) {
      waiter.reject(new Error("Mailbox cleared"));
    }
  }

  private pullOne(to: string): Mail | undefined {
    const index = this.queue.findIndex((mail) => mail.to === to);
    if (index === -1) {
      return undefined;
    }
    const [mail] = this.queue.splice(index, 1);
    return mail;
  }

  private resolveNextWaiter(to: string): void {
    const waiters = this.waiters.get(to);
    if (!waiters?.length) {
      return;
    }

    const mail = this.pullOne(to);
    if (!mail) {
      return;
    }

    const waiter = waiters.shift();
    if (waiters.length === 0) {
      this.waiters.delete(to);
    }
    waiter?.resolve(mail);
  }
}

const mailboxes = new Map<string, FlowMailbox>();

function mailboxKey(flowId: string, runId = ""): string {
  return runId ? `${flowId}:${runId}` : flowId;
}

export function getMailbox(flowId: string, runId = ""): FlowMailbox {
  const key = mailboxKey(flowId, runId);
  const existing = mailboxes.get(key);
  if (existing) {
    return existing;
  }

  const mailbox = new FlowMailbox(flowId, runId);
  mailboxes.set(key, mailbox);
  return mailbox;
}

export function removeMailbox(flowId: string, runId = ""): void {
  if (runId) {
    const mailbox = mailboxes.get(mailboxKey(flowId, runId));
    mailbox?.clear();
    mailboxes.delete(mailboxKey(flowId, runId));
    return;
  }

  for (const [key, mailbox] of mailboxes) {
    if (key === flowId || key.startsWith(`${flowId}:`)) {
      mailbox.clear();
      mailboxes.delete(key);
    }
  }
}
