import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

declare global {
  interface Window {
    __squadflowAgentRefs?: Map<string, HTMLElement>;
  }
}

function extractFunctionSource(name: string): string {
  const source = fs.readFileSync(path.resolve(process.cwd(), "../desktop/main.js"), "utf8");
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not parse function ${name}`);
}

describe("Electron browser agent fill", () => {
  it("fills textarea elements with the native textarea value setter", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    window.__squadflowAgentRefs = new Map([["field-1", textarea]]);
    const agentFillElement = new Function(`${extractFunctionSource("agentFillElement")}; return agentFillElement;`)() as (
      ref: string,
      value: string,
    ) => { ok: boolean; reason?: string };

    const result = agentFillElement("field-1", "hello");

    expect(result).toEqual({ ok: true });
    expect(textarea.value).toBe("hello");
  });
});
