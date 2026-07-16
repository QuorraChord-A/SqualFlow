import { describe, expect, it } from "vitest";
import {
  codexAppServerBaseArgs,
  resolveExternalCodexCommand,
  resolveCodexRuntimeProfile,
  withCodexRuntimeProfileEnv,
} from "../src/runtime/adapters/codexRuntimeProfile.js";

describe("Codex runtime profile resolver", () => {
  it("defaults to bundled legacy runtime with flat MCP support", () => {
    const profile = resolveCodexRuntimeProfile({
      SQUADFLOW_BUNDLED_CODEX_COMMAND: "/opt/squadflow/codex",
      SQUADFLOW_CODEX_HOME: "/tmp/squadflow-codex-home",
    });

    expect(profile).toEqual(expect.objectContaining({
      id: "bundled-legacy-flat-mcp",
      command: "/opt/squadflow/codex",
      codexHome: "/tmp/squadflow-codex-home",
      mcpApprovalProtocol: "elicitation-action",
    }));
    expect(codexAppServerBaseArgs(profile)).toEqual([
      "app-server",
      "--listen",
      "stdio://",
      "--disable",
      "image_generation",
    ]);
    expect(withCodexRuntimeProfileEnv({ FOO: "bar" }, profile)).toEqual({
      FOO: "bar",
      CODEX_HOME: "/tmp/squadflow-codex-home",
    });
  });

  it("keeps the external modern runtime path available for future rollout", () => {
    const profile = resolveCodexRuntimeProfile({
      SQUADFLOW_CODEX_RUNTIME_MODE: "external-modern",
      SQUADFLOW_EXTERNAL_CODEX_COMMAND: "/usr/local/bin/codex",
    });

    expect(profile).toEqual(expect.objectContaining({
      id: "external-modern",
      command: "/usr/local/bin/codex",
      mcpApprovalProtocol: "elicitation-action",
    }));
    expect(profile.codexHome).toBeUndefined();
    expect(codexAppServerBaseArgs(profile)).toEqual([
      "app-server",
      "--stdio",
      "--disable",
      "image_generation",
    ]);
  });

  it("can prefer the external runtime for inherited local auth", () => {
    const profile = resolveCodexRuntimeProfile({
      SQUADFLOW_BUNDLED_CODEX_COMMAND: "/opt/squadflow/codex-bundled",
      SQUADFLOW_EXTERNAL_CODEX_COMMAND: "/usr/local/bin/codex",
      SQUADFLOW_CODEX_HOME: "/tmp/squadflow-codex-home",
    }, { preferExternal: true });

    expect(profile).toEqual(expect.objectContaining({
      id: "external-modern",
      command: "/usr/local/bin/codex",
      mcpApprovalProtocol: "elicitation-action",
    }));
    expect(profile.codexHome).toBeUndefined();
  });

  it("resolves an absolute executable candidate when a desktop process PATH has no codex", () => {
    expect(resolveExternalCodexCommand({ PATH: "/usr/bin:/bin" }, [process.execPath])).toBe(process.execPath);
  });

  it("fails before spawn with an actionable error when no external runtime exists", () => {
    expect(() => resolveExternalCodexCommand({ PATH: "" }, [])).toThrow(
      /Codex CLI executable not found.*SQUADFLOW_EXTERNAL_CODEX_COMMAND/,
    );
  });
});
