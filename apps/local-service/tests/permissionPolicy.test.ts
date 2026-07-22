import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkPermission } from "../src/permissions/permissionPolicy.js";

const writableTools = new Set(["read", "search", "write", "edit", "shell"]);
const readOnlyTools = new Set(["read", "search", "shell"]);
const packageInstallWrapperCommands = [
  "env HTTP_PROXY=http://localhost:53653 npm install",
  "env FOO=bar npm install",
  "time npm install",
  "command npm install",
  "npm --prefix apps/renderer install",
  "npm --prefix=apps/renderer install",
  "npm -g install typescript",
] as const;

function checkAutoEditShell(command: string) {
  return checkPermission({
    toolName: "Bash",
    capability: "shell",
    input: { command },
    cwd: "/repo",
    readableDirs: ["/repo"],
    writableDirs: ["/repo"],
    authorizedCapabilities: new Set(["shell", "write"] as const),
    authorizedTools: new Set<string>(),
    riskMode: "auto_edit",
  });
}

describe("checkPermission", () => {
  it("denies non-internal tools outside the authorized tool list before path checks", () => {
    const result = checkPermission({
      toolName: "write",
      input: { path: "/repo/a.ts" },
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: ["/repo"],
      authorizedTools: new Set(["read"]),
    });

    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("not allowed");
    }
  });

  it("requires MCP tools to be explicitly authorized", () => {
    const result = checkPermission({
      toolName: "mcp__squadflow-leader__ask_user",
      input: {},
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: ["/repo"],
      authorizedTools: writableTools,
    });

    expect(result.behavior).toBe("deny");
  });

  it("allows authorized MCP tools", () => {
    const result = checkPermission({
      toolName: "mcp__squadflow-leader__ask_user",
      input: {},
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: ["/repo"],
      authorizedTools: new Set([...writableTools, "mcp__squadflow-leader__ask_user"]),
    });

    expect(result.behavior).toBe("allow");
  });

  it("denies AskUserQuestion and points callers to ask_user", () => {
    const result = checkPermission({
      toolName: "AskUserQuestion",
      input: {},
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: ["/repo"],
      authorizedTools: new Set(["AskUserQuestion"]),
    });

    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("ask_user");
    }
  });

  it("allows internal tools regardless of expert tool authorization", () => {
    const result = checkPermission({
      toolName: "SandboxNetworkAccess",
      input: { host: "registry.npmmirror.com" },
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: [],
      authorizedTools: new Set(["read"]),
    });

    expect(result.behavior).toBe("allow");
  });

  it("allows read tools without a path", () => {
    const result = checkPermission({
      toolName: "search",
      input: { query: "**/*.ts" },
      cwd: "/repo",
      readableDirs: [],
      writableDirs: [],
      authorizedTools: readOnlyTools,
    });

    expect(result.behavior).toBe("allow");
  });

  it("authorizes provider tools through system capabilities", () => {
    const result = checkPermission({
      toolName: "Bash",
      capability: "shell",
      input: { command: "npm test" },
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: [],
      authorizedTools: new Set<string>(),
      authorizedCapabilities: new Set(["read", "shell"]),
    });

    expect(result).toEqual({ behavior: "allow" });
  });

  it("allows web search when the web_search capability is authorized", () => {
    const result = checkPermission({
      toolName: "WebSearch",
      capability: "web_search",
      input: { query: "runtime sdk docs" },
      cwd: "/repo",
      readableDirs: [],
      writableDirs: [],
      authorizedTools: new Set<string>(),
      authorizedCapabilities: new Set(["web_search"]),
    });

    expect(result).toEqual({ behavior: "allow" });
  });

  it("allows read tools inside cwd, readable dirs, and writable dirs", () => {
    const roots = {
      cwd: "/repo/work",
      readable: "/repo/readable",
      writable: "/repo/writable",
    };

    for (const filePath of [
      "src/app.ts",
      "/repo/readable/doc.md",
      "/repo/writable/generated.ts",
    ]) {
      const result = checkPermission({
        toolName: "read",
        input: { path: filePath },
        cwd: roots.cwd,
        readableDirs: [roots.readable],
        writableDirs: [roots.writable],
        authorizedTools: readOnlyTools,
      });

      expect(result.behavior).toBe("allow");
    }
  });

  it("allows Leader reads outside configured directories when explicitly enabled", () => {
    const result = checkPermission({
      toolName: "Read",
      capability: "read",
      input: { path: "/etc/hosts" },
      cwd: "/repo/work",
      readableDirs: ["/repo/work"],
      writableDirs: ["/repo/work", "/tmp"],
      allowReadOutsideDirs: true,
      authorizedCapabilities: new Set(["read"]),
      authorizedTools: new Set<string>(),
    });

    expect(result).toEqual({ behavior: "allow" });
  });

  it("denies read tools outside allowed directories without prefix false positives", () => {
    const result = checkPermission({
      toolName: "read",
      input: { path: "/repo-other" },
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: [],
      authorizedTools: readOnlyTools,
    });

    expect(result.behavior).toBe("deny");
  });

  it("denies read paths that escape through a symlink inside cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-policy-"));
    const cwd = path.join(root, "cwd");
    const outside = path.join(root, "outside");
    fs.mkdirSync(cwd);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(cwd, "link"));

    try {
      for (const [toolName, input] of [
        ["read", { path: "link/secret.txt" }],
        ["read", { path: "link" }],
      ] as const) {
        const result = checkPermission({
          toolName,
          input,
          cwd,
          readableDirs: [],
          writableDirs: [],
          authorizedTools: readOnlyTools,
        });

        expect(result.behavior).toBe("deny");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows write inside cwd and writable directories when authorized", () => {
    for (const filePath of ["src/app.ts", "/repo/project/file.ts"]) {
      const result = checkPermission({
        toolName: "write",
        input: { path: filePath },
        cwd: "/repo/work",
        readableDirs: ["/repo/project"],
          writableDirs: ["/repo/work", "/repo/project"],
        authorizedTools: writableTools,
      });

      expect(result.behavior).toBe("allow");
    }
  });

  it("allows ordinary Write operations in auto-edit mode", () => {
    const result = checkPermission({
      toolName: "Write",
      capability: "write",
      input: { path: "src/app.ts" },
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: ["/repo"],
      authorizedCapabilities: new Set(["write"]),
      authorizedTools: new Set<string>(),
      riskMode: "auto_edit",
    });

    expect(result).toEqual({ behavior: "allow" });
  });

  it("prompts only for the fixed shell risk list in auto-edit mode", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-risk-list-"));
    const base = {
      toolName: "Bash",
      capability: "shell" as const,
      cwd: root,
      readableDirs: [root],
      writableDirs: [root],
      authorizedCapabilities: new Set(["shell", "write"] as const),
      authorizedTools: new Set<string>(),
      riskMode: "auto_edit" as const,
    };

    try {
      for (const command of [
        "rm -rf build",
        "rmdir empty",
        "git clean -fd",
        "git reset --hard HEAD~1",
        "git push --force origin main",
        "git push -f origin main",
        "env FOO=1 sh -c 'rm -rf build'",
      ]) {
        expect(checkPermission({ ...base, input: { command } })).toEqual({
          behavior: "deny",
          message: "该风险操作需要用户确认",
          requiresConfirmation: true,
        });
      }
      for (const command of [
        "npm install",
        "git push origin main",
        "echo changed > result.txt",
      ]) {
        expect(checkPermission({ ...base, input: { command } }).behavior).toBe("allow");
      }
      expect(checkPermission({ ...base, riskMode: "full_access", input: { command: "rm -rf build" } }))
        .toEqual({ behavior: "allow" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["dollar command substitution", "echo $(rm -rf x)"],
    ["backtick command substitution", "echo `rm -rf x`"],
    ["nested command substitution uncertainty", "echo $(echo $(git rev-parse HEAD))"],
    ["unclosed command substitution uncertainty", "echo \"$(git rev-parse HEAD)"],
    ["direct xargs execution", "xargs rm"],
    ["piped xargs execution", "find . -name '*.tmp' | xargs rm"],
    ["xargs options", "xargs -0 rm"],
  ])("prompts for %s", (_scenario, command) => {
    expect(checkAutoEditShell(command)).toEqual({
      behavior: "deny",
      message: "该风险操作需要用户确认",
      requiresConfirmation: true,
    });
  });

  it.each([
    ["safe command substitution", "echo \"$(git rev-parse HEAD)\""],
    ["stderr redirection", "npm test 2>&1"],
    ["force-with-lease push", "git push --force-with-lease origin main"],
    ["find delete outside the fixed list", "find . -delete"],
    ["single-quoted command substitution literal", "echo '$(rm -rf x)'"],
    ["arithmetic substitution", "echo $((1 + 2))"],
  ])("does not prompt for %s", (_scenario, command) => {
    expect(checkAutoEditShell(command).behavior).toBe("allow");
  });

  it("keeps project and role boundaries hard in auto mode", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-auto-boundary-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "permission-auto-outside-"));
    try {
      const writeResult = checkPermission({
        toolName: "Write",
        capability: "write",
        input: { path: path.join(outside, "escape.ts") },
        cwd: root,
        readableDirs: [root],
        writableDirs: [root],
        authorizedCapabilities: new Set(["write"]),
        authorizedTools: new Set<string>(),
        riskMode: "full_access",
      });
      expect(writeResult.behavior).toBe("deny");

      const shellResult = checkPermission({
        toolName: "Bash",
        capability: "shell",
        input: { command: `cd ${outside} && touch escape.txt` },
        cwd: root,
        readableDirs: [root],
        writableDirs: [root],
        authorizedCapabilities: new Set(["shell", "write"]),
        authorizedTools: new Set<string>(),
        riskMode: "full_access",
      });
      expect(shellResult.behavior).toBe("deny");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("denies write without an explicit path", () => {
    const result = checkPermission({
      toolName: "edit",
      input: {},
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: ["/repo"],
      authorizedTools: writableTools,
    });

    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("明确");
    }
  });

  it("denies write outside cwd and writable directories without prefix false positives", () => {
    const result = checkPermission({
      toolName: "write",
      input: { path: "/repo-writable/a.ts" },
      cwd: "/repo",
      readableDirs: ["/repo-writable"],
      writableDirs: ["/repo"],
      authorizedTools: writableTools,
    });

    expect(result.behavior).toBe("deny");
  });

  it("denies writes to a missing file under a symlink that escapes cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-policy-"));
    const cwd = path.join(root, "cwd");
    const outside = path.join(root, "outside");
    fs.mkdirSync(cwd);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(cwd, "link"));

    try {
      const result = checkPermission({
        toolName: "write",
        input: { path: "link/escape.txt" },
        cwd,
        readableDirs: [],
        writableDirs: [],
        authorizedTools: writableTools,
      });

      expect(result.behavior).toBe("deny");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies package installs for read-only experts even when Bash is authorized", () => {
    const result = checkPermission({
      toolName: "shell",
      input: { command: "cd apps/renderer && npm install next react react-dom" },
      cwd: "/tmp/scratch",
      readableDirs: ["/repo"],
      writableDirs: ["/repo"],
      authorizedTools: readOnlyTools,
    });

    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("依赖安装");
    }
  });

  it("denies package runners for read-only experts", () => {
    const result = checkPermission({
      toolName: "shell",
      input: { command: "cd apps/renderer && npx tsc --noEmit" },
      cwd: "/tmp/scratch",
      readableDirs: ["/repo"],
      writableDirs: [],
      authorizedTools: readOnlyTools,
    });

    expect(result.behavior).toBe("deny");
  });

  it("denies package installs behind common wrappers and npm options for read-only experts", () => {
    for (const command of packageInstallWrapperCommands) {
      const result = checkPermission({
        toolName: "shell",
        input: { command },
        cwd: "/tmp/scratch",
        readableDirs: ["/repo"],
        writableDirs: [],
        authorizedTools: readOnlyTools,
      });

      expect(result.behavior).toBe("deny");
    }
  });

  it("denies read-only Bash commands that write project files", () => {
    const result = checkPermission({
      toolName: "shell",
      input: { command: "echo hacked > app/page.tsx" },
      cwd: "/repo/project",
      readableDirs: ["/repo/project"],
      writableDirs: ["/tmp/scratch"],
      authorizedTools: readOnlyTools,
    });

    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("read-only");
    }
  });

  it("does not let compact shell redirections bypass project boundaries", () => {
    const result = checkPermission({
      toolName: "Bash",
      capability: "shell",
      input: { command: "echo hacked>app/page.tsx" },
      cwd: "/repo/project",
      readableDirs: ["/repo/project"],
      writableDirs: ["/tmp/scratch"],
      authorizedCapabilities: new Set(["read", "shell"]),
      authorizedTools: new Set<string>(),
      riskMode: "full_access",
    });

    expect(result.behavior).toBe("deny");
  });

  it("does not prompt for compact shell redirections in auto-edit mode", () => {
    const result = checkPermission({
      toolName: "Bash",
      capability: "shell",
      input: { command: "echo changed>result.txt" },
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: ["/repo"],
      authorizedCapabilities: new Set(["shell", "write"]),
      authorizedTools: new Set<string>(),
      riskMode: "auto_edit",
    });

    expect(result).toEqual({ behavior: "allow" });
  });

  it("denies read-only Bash commands that cd into the project before writing", () => {
    const result = checkPermission({
      toolName: "shell",
      input: { command: "cd /repo/project && mkdir -p app && echo hacked > app/page.tsx" },
      cwd: "/tmp/scratch",
      readableDirs: ["/repo/project"],
      writableDirs: ["/tmp/scratch"],
      authorizedTools: readOnlyTools,
    });

    expect(result.behavior).toBe("deny");
  });

  it("allows read-only Bash commands to write scratch files", () => {
    const input = { command: "echo ok > /tmp/scratch/result.log" };
    const result = checkPermission({
      toolName: "shell",
      input,
      cwd: "/tmp/scratch",
      readableDirs: ["/repo/project"],
      writableDirs: ["/tmp/scratch"],
      authorizedTools: readOnlyTools,
    });

    expect(result).toEqual({ behavior: "allow" });
  });

  it("does not treat quoted package install text as an install command", () => {
    const input = { command: "grep 'npm install' README.md" };
    const result = checkPermission({
      toolName: "shell",
      input,
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: [],
      authorizedTools: readOnlyTools,
    });

    expect(result).toEqual({ behavior: "allow" });
  });

  it("does not treat comment package install text as an install command", () => {
    const input = { command: "echo checked # npm install should not run" };
    const result = checkPermission({
      toolName: "shell",
      input,
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: [],
      authorizedTools: readOnlyTools,
    });

    expect(result).toEqual({ behavior: "allow" });
  });

  it("rewrites writable package installs with proxy cleanup, registry defaults, and a timeout cap", () => {
    const result = checkPermission({
      toolName: "shell",
      input: {
        command: "NODE_ENV=production HTTP_PROXY=http://localhost:53653 HTTPS_PROXY=http://localhost:53653 npm install 2>&1",
        timeout: 300_000,
      },
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: ["/repo"],
      authorizedTools: writableTools,
    });

    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput?.timeout).toBe(120_000);
      expect(result.updatedInput?.command).not.toContain("localhost:53653");
      expect(result.updatedInput?.command).toContain("-u HTTP_PROXY");
      expect(result.updatedInput?.command).toContain("-u HTTPS_PROXY");
      expect(result.updatedInput?.command).toContain("NODE_ENV=production");
      expect(result.updatedInput?.command).toContain("registry.npmmirror.com");
      expect(result.updatedInput?.command).toContain("npm install 2>&1");
    }
  });

  it("strips proxy assignments after changing directories before package install", () => {
    const result = checkPermission({
      toolName: "shell",
      input: {
        command: "cd apps/renderer && HTTP_PROXY=http://localhost:53653 HTTPS_PROXY=http://localhost:53653 npm install",
      },
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: ["/repo"],
      authorizedTools: writableTools,
    });

    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput?.command).not.toContain("localhost:53653");
      expect(result.updatedInput?.command).toContain("cd apps/renderer");
      expect(result.updatedInput?.command).toContain("npm install");
    }
  });

  it("rewrites package installs behind common wrappers and npm options for writable experts", () => {
    for (const command of packageInstallWrapperCommands) {
      const result = checkPermission({
        toolName: "shell",
        input: { command, timeout: 300_000 },
        cwd: "/repo",
        readableDirs: ["/repo"],
        writableDirs: ["/repo"],
        authorizedTools: writableTools,
      });

      expect(result.behavior).toBe("allow");
      if (result.behavior === "allow") {
        expect(result.updatedInput?.timeout).toBe(120_000);
        expect(result.updatedInput?.command).toContain("registry.npmmirror.com");
        expect(result.updatedInput?.command).toContain("npm");
      }
    }
  });

  it("strips proxy assignments inside env wrapper package installs", () => {
    const result = checkPermission({
      toolName: "shell",
      input: {
        command: "env HTTP_PROXY=http://localhost:53653 HTTPS_PROXY=http://localhost:53653 npm install",
      },
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: ["/repo"],
      authorizedTools: writableTools,
    });

    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput?.command).not.toContain("localhost:53653");
      expect(result.updatedInput?.command).toContain("env npm install");
    }
  });

  it("preserves shorter package install timeouts and explicit registries", () => {
    const result = checkPermission({
      toolName: "shell",
      input: {
        command: "npm_config_registry=https://registry.npmjs.org npm install",
        timeout: 30_000,
      },
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: ["/repo"],
      authorizedTools: writableTools,
    });

    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput?.timeout).toBe(30_000);
      expect(result.updatedInput?.command).toContain("registry.npmjs.org");
      expect(result.updatedInput?.command).not.toContain("registry.npmmirror.com");
    }
  });

  it("allows npm test stderr redirection unchanged when authorized", () => {
    const input = { command: "npm test 2>&1" };
    const result = checkPermission({
      toolName: "shell",
      input,
      cwd: "/repo",
      readableDirs: ["/repo"],
      writableDirs: [],
      authorizedTools: readOnlyTools,
    });

    expect(result).toEqual({ behavior: "allow" });
  });

  it("denies shell redirection outside the project in every risk mode", () => {
    for (const riskMode of ["auto_edit", "full_access"] as const) {
      const result = checkPermission({
        toolName: "shell",
        capability: "shell",
        input: { command: 'echo -n "should_not_exist" > /tmp/squadflow-boundary.txt' },
        cwd: "/repo",
        readableDirs: [],
        writableDirs: ["/repo"],
        authorizedCapabilities: new Set(["read", "write", "shell"]),
        authorizedTools: new Set<string>(),
        riskMode,
      });

      expect(result).toEqual({
        behavior: "deny",
        message: "Bash 写操作必须落在项目或授权可写目录内。",
      });
    }
  });
});
