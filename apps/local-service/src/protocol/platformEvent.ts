import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export const PLATFORM_EVENT_TYPES = [
  "expert_result",
  "plan_feedback",
  "spec_requested",
  "spec_run",
  "decision_answered",
  "decision_cancelled",
  "plan_approved",
  "turn_recovery",
  "guide",
  "browser_comment",
  "attachment",
  "dispatch_env",
  "leader_message",
  "flow_name_request",
] as const;

export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number];

export type PlatformEventSegment = {
  kind: "event";
  type: PlatformEventType;
  attrs: Record<string, string>;
  body: string;
  raw: string;
};

export type UserTextSegment = {
  kind: "user_text";
  raw: string;
};

export type MessageSegment = PlatformEventSegment | UserTextSegment;

const saltFileName = "platform-event.json";
const reservedBodySequence = /<(?=\/?squadflow)/iu;
const reservedBodySequenceGlobal = /<(?=\/?squadflow)/giu;
const eventOpeningTag = /<squadflow\b((?:[^">]|"[^"]*")*)>/giu;
const eventClosingTag = "</squadflow>";
const eventTypes = new Set<string>(PLATFORM_EVENT_TYPES);
const allowedAttrs: Record<PlatformEventType, ReadonlySet<string>> = {
  expert_result: new Set(["task"]),
  plan_feedback: new Set(),
  spec_requested: new Set(),
  spec_run: new Set(),
  decision_answered: new Set(),
  decision_cancelled: new Set(),
  plan_approved: new Set(),
  turn_recovery: new Set(),
  guide: new Set(),
  browser_comment: new Set(["n", "url", "label", "selector"]),
  attachment: new Set(),
  dispatch_env: new Set(["cwd", "scratch", "write"]),
  leader_message: new Set(),
  flow_name_request: new Set(),
};

let cachedSalt: { root: string; value: string } | null = null;

function saltPath(root: string) {
  return path.join(root, saltFileName);
}

function readOrCreateSalt(): string {
  const root = config.agentRuntimeConfigRoot;
  if (cachedSalt?.root === root) return cachedSalt.value;

  const filePath = saltPath(root);
  if (fs.existsSync(filePath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
      || typeof (parsed as { salt?: unknown }).salt !== "string"
      || !(parsed as { salt: string }).salt
    ) {
      throw new Error(`Invalid platform event salt file: ${filePath}`);
    }
    const value = (parsed as { salt: string }).salt;
    cachedSalt = { root, value };
    return value;
  }

  fs.mkdirSync(root, { recursive: true });
  const value = randomBytes(32).toString("hex");
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, salt: value }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  cachedSalt = { root, value };
  return value;
}

export function computeFlowSig(flowId: string): string {
  return createHash("sha256").update(`${readOrCreateSalt()}${flowId}`).digest("hex").slice(0, 8);
}

function isPlatformEventType(value: string): value is PlatformEventType {
  return eventTypes.has(value);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

function decodeAttribute(value: string): string {
  return value.replace(/&(amp|quot|lt);/gu, (match, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "quot") return '"';
    if (entity === "lt") return "<";
    return match;
  });
}

function encodeBody(body: string): { body: string; encoded: boolean } {
  if (!reservedBodySequence.test(body)) return { body, encoded: false };
  return {
    body: body.replaceAll("&", "&amp;").replace(reservedBodySequenceGlobal, "&lt;"),
    encoded: true,
  };
}

function decodeBody(body: string): string {
  return body.replace(/&(amp|lt);/gu, (match, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    return match;
  });
}

function assertAttrs(type: PlatformEventType, attrs: Record<string, string>) {
  for (const [name, value] of Object.entries(attrs)) {
    if (!allowedAttrs[type].has(name)) throw new Error(`Unsupported ${type} attribute: ${name}`);
    if (!value) throw new Error(`Platform event attribute cannot be empty: ${name}`);
  }
  if (type === "expert_result" && !attrs.task) throw new Error("expert_result requires task");
  if (type === "browser_comment") {
    const markerNumber = Number(attrs.n);
    if (!Number.isInteger(markerNumber) || markerNumber <= 0) {
      throw new Error("browser_comment requires a positive integer n");
    }
  }
  if (type === "dispatch_env") {
    if (!attrs.cwd || !attrs.scratch || !attrs.write) throw new Error("dispatch_env requires cwd, scratch and write");
    if (attrs.write !== "true" && attrs.write !== "false") throw new Error("dispatch_env write must be true or false");
  }
}

export function buildPlatformEvent(input: {
  flowId: string;
  type: PlatformEventType;
  attrs?: Record<string, string>;
  body: string;
}): string {
  const attrs = input.attrs ?? {};
  assertAttrs(input.type, attrs);
  const encodedBody = encodeBody(input.body);
  const attributes = [
    `type="${input.type}"`,
    ...Object.entries(attrs).map(([name, value]) => `${name}="${escapeAttribute(value)}"`),
    ...(encodedBody.encoded ? ['enc="entities"'] : []),
    `sig="${computeFlowSig(input.flowId)}"`,
  ];
  return `<squadflow ${attributes.join(" ")}>${encodedBody.body}</squadflow>`;
}

type ParsedOpeningTag = {
  type: PlatformEventType;
  attrs: Record<string, string>;
  encoded: boolean;
};

function parseOpeningTag(source: string, expectedSig: string): ParsedOpeningTag | null {
  const attributes: Record<string, string> = {};
  const attributePattern = /([a-z][a-z0-9_]*)="([^"]*)"/giu;
  let cursor = 0;
  for (const match of source.matchAll(attributePattern)) {
    const index = match.index ?? 0;
    if (source.slice(cursor, index).trim()) return null;
    const name = match[1]?.toLowerCase() ?? "";
    if (!name || name in attributes) return null;
    attributes[name] = match[2] ?? "";
    cursor = index + match[0].length;
  }
  if (source.slice(cursor).trim()) return null;

  const typeValue = decodeAttribute(attributes.type ?? "");
  if (!isPlatformEventType(typeValue)) return null;
  if (decodeAttribute(attributes.sig ?? "") !== expectedSig) return null;
  if (attributes.enc !== undefined && attributes.enc !== "entities") return null;

  const attrs = Object.fromEntries(
    Object.entries(attributes)
      .filter(([name]) => name !== "type" && name !== "sig" && name !== "enc")
      .map(([name, value]) => [name, decodeAttribute(value)]),
  );
  try {
    assertAttrs(typeValue, attrs);
  } catch {
    return null;
  }
  return { type: typeValue, attrs, encoded: attributes.enc === "entities" };
}

function pushUserText(segments: MessageSegment[], raw: string) {
  if (raw) segments.push({ kind: "user_text", raw });
}

export function parseMessageSegments(text: string, flowId: string): MessageSegment[] {
  if (!text) return [];
  const expectedSig = computeFlowSig(flowId);
  const segments: MessageSegment[] = [];
  let cursor = 0;
  let searchFrom = 0;

  while (searchFrom < text.length) {
    eventOpeningTag.lastIndex = searchFrom;
    const opening = eventOpeningTag.exec(text);
    if (!opening) break;
    const parsed = parseOpeningTag(opening[1] ?? "", expectedSig);
    if (!parsed) {
      searchFrom = opening.index + 1;
      continue;
    }
    const bodyStart = opening.index + opening[0].length;
    const closingIndex = text.toLowerCase().indexOf(eventClosingTag, bodyStart);
    if (closingIndex < 0) {
      searchFrom = opening.index + 1;
      continue;
    }

    const userTextEnd = opening.index >= cursor + 2 && text.slice(opening.index - 2, opening.index) === "\n\n"
      ? opening.index - 2
      : opening.index;
    pushUserText(segments, text.slice(cursor, userTextEnd));
    const eventEnd = closingIndex + eventClosingTag.length;
    const raw = text.slice(opening.index, eventEnd);
    const rawBody = text.slice(bodyStart, closingIndex);
    segments.push({
      kind: "event",
      type: parsed.type,
      attrs: parsed.attrs,
      body: parsed.encoded ? decodeBody(rawBody) : rawBody,
      raw,
    });
    cursor = text.slice(eventEnd, eventEnd + 2) === "\n\n" ? eventEnd + 2 : eventEnd;
    searchFrom = cursor;
  }

  pushUserText(segments, text.slice(cursor));
  return segments;
}
