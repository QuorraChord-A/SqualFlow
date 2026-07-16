import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorkspaceFilePreview from "./WorkspaceFilePreview";

vi.mock("@/components/ai-elements-official/message", () => ({
  MessageResponse: ({ children }: { children: string }) => <div data-testid="rendered-markdown">{children}</div>,
}));

vi.mock("./CodeFilePreview", () => ({
  default: ({ content, language, onOpenInBrowser }: { content: string; language: string; onOpenInBrowser?: () => void }) => (
    <div data-testid="code-file-preview">
      {language}:{content}
      {onOpenInBrowser ? <button type="button" onClick={onOpenInBrowser}>在内置浏览器打开</button> : null}
    </div>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockPreviewResponse(content: string, ok = true) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok,
    json: async () => ok ? { path: "file", content } : { detail: content },
  }));
}

describe("WorkspaceFilePreview", () => {
  it("renders Markdown files as rich content", async () => {
    mockPreviewResponse("# Hello");
    render(<WorkspaceFilePreview flowId="flow-1" filePath="README.md" showPath={false} />);

    expect(await screen.findByTestId("rendered-markdown")).toHaveTextContent("# Hello");
  });

  it("renders source files in the code preview", async () => {
    mockPreviewResponse("export const value = 1;");
    render(<WorkspaceFilePreview flowId="flow-1" filePath="src/app.tsx" showPath={false} />);

    const rendered = await screen.findByTestId("code-file-preview");
    expect(rendered).toHaveTextContent("tsx:export const value = 1;");
  });

  it("opens the current source file in the embedded browser from the code preview", async () => {
    const onOpenInBrowser = vi.fn();
    mockPreviewResponse("export const value = 1;");
    render(
      <WorkspaceFilePreview
        flowId="flow-1"
        filePath="src/app.tsx"
        showPath={false}
        onOpenInBrowser={onOpenInBrowser}
      />,
    );

    (await screen.findByRole("button", { name: "在内置浏览器打开" })).click();
    expect(onOpenInBrowser).toHaveBeenCalledTimes(1);
  });

  it("does not request known binary files", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkspaceFilePreview flowId="flow-1" filePath="image.png" />);

    expect(await screen.findByText("当前仅支持预览文本文件")).toBeInTheDocument();
    expect(screen.getByText("image.png")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows API preview errors for unknown text-like files", async () => {
    mockPreviewResponse("Only UTF-8 text files can be previewed", false);
    render(<WorkspaceFilePreview flowId="flow-1" filePath="unknown.data" />);

    expect(await screen.findByText("Only UTF-8 text files can be previewed")).toBeInTheDocument();
  });

  it("reuses loaded content when switching back to an already loaded file", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.searchParams.get("path");
      return {
        ok: true,
        json: async () => ({
          path,
          content: path === "src/one.ts" ? "export const one = 1;" : "export const two = 2;",
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<WorkspaceFilePreview flowId="flow-1" filePath="src/one.ts" showPath={false} />);
    expect(await screen.findByTestId("code-file-preview")).toHaveTextContent("export const one = 1;");

    rerender(<WorkspaceFilePreview flowId="flow-1" filePath="src/two.ts" showPath={false} />);
    expect(await screen.findByTestId("code-file-preview")).toHaveTextContent("export const two = 2;");

    rerender(<WorkspaceFilePreview flowId="flow-1" filePath="src/one.ts" showPath={false} />);
    expect(screen.queryByText("正在加载文件")).not.toBeInTheDocument();
    expect(screen.getByTestId("code-file-preview")).toHaveTextContent("export const one = 1;");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
