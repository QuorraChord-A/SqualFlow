import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceFilesPanel from "./WorkspaceFilesPanel";
import { WORKSPACE_FILE_TREE_WIDTH_STORAGE_KEY } from "./workspaceFiles";

vi.mock("./WorkspaceFilePreview", () => ({
  default: ({ filePath }: { filePath: string }) => <div data-testid="mock-file-preview">preview:{filePath}</div>,
}));

const rootEntries = [
  {
    name: "src",
    path: "src",
    type: "directory" as const,
    has_children: true,
    size: null,
    modified_at: "2026-06-21T00:00:00.000Z",
  },
  {
    name: "README.md",
    path: "README.md",
    type: "file" as const,
    has_children: false,
    size: 20,
    modified_at: "2026-06-21T00:00:00.000Z",
  },
];

const srcEntries = [
  {
    name: "app.tsx",
    path: "src/app.tsx",
    type: "file" as const,
    has_children: false,
    size: 40,
    modified_at: "2026-06-21T00:00:00.000Z",
  },
];

function installFetchMock() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "DELETE") {
      return { ok: true, json: async () => ({ deleted: url.searchParams.get("path") }) } as Response;
    }
    const directoryPath = url.searchParams.get("path") ?? "";
    const body = directoryPath === "src"
      ? { path: "src", entries: srcEntries, truncated: false }
      : { path: "", entries: rootEntries, truncated: false };
    return {
      ok: true,
      json: async () => body,
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkspaceFilesPanel", () => {
  it("starts with an empty preview beside the visible file tree", async () => {
    installFetchMock();
    render(
      <WorkspaceFilesPanel
        flowId="flow-empty"
        rootPath="/tmp/project"
        treeAvailable
      />,
    );

    expect(await screen.findByRole("treeitem", { name: "展开目录 src" })).toBeInTheDocument();
    expect(screen.getByTestId("workspace-files-shell")).toHaveAttribute("data-tree-visible", "true");
    expect(screen.getByTestId("workspace-file-preview-pane")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-file-preview-pane")).toHaveStyle({ minWidth: "192px" });
    expect(screen.getByTestId("workspace-file-tree")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-file-tree-drawer")).toHaveStyle({
      width: "320px",
      minWidth: "192px",
      maxWidth: "min(60%, calc(100% - 192px))",
    });
    expect(screen.getByRole("button", { name: "隐藏文件列表" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "当前文件路径" })).toHaveTextContent("project");
    expect(screen.getByTestId("workspace-files-toolbar")).toContainElement(screen.getByRole("button", { name: "刷新文件树" }));
    expect(screen.getByTestId("workspace-file-tree")).not.toContainElement(screen.getByRole("button", { name: "刷新文件树" }));
    expect(screen.getByText("从工作区目录树中选择文件")).toBeInTheDocument();
    expect(screen.queryByText("选择文件以预览")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制文件路径" })).not.toBeInTheDocument();
  });

  it("loads folders lazily and opens the selected file through the parent tab state", async () => {
    const user = userEvent.setup();
    const fetchMock = installFetchMock();
    const onOpenFile = vi.fn();
    const { rerender } = render(
      <WorkspaceFilesPanel
        flowId="flow-1"
        rootPath="/tmp/project"
        treeAvailable
        onOpenFile={onOpenFile}
      />,
    );

    await user.click(await screen.findByRole("treeitem", { name: "展开目录 src" }));
    await user.click(await screen.findByRole("treeitem", { name: "打开文件 src/app.tsx" }));
    expect(onOpenFile).toHaveBeenLastCalledWith("src/app.tsx");
    expect(screen.getByTestId("workspace-file-tree")).toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "搜索工作区文件" });
    await user.type(search, "README");
    expect(screen.getByRole("treeitem", { name: "打开文件 README.md" })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "折叠目录 src" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("treeitem", { name: "打开文件 README.md" }));
    expect(onOpenFile).toHaveBeenLastCalledWith("README.md");

    rerender(
      <WorkspaceFilesPanel
        flowId="flow-1"
        rootPath="/tmp/project"
        treeAvailable
        activeFile="src/app.tsx"
        onOpenFile={onOpenFile}
      />,
    );
    expect(screen.getByTestId("mock-file-preview")).toHaveTextContent("preview:src/app.tsx");
    expect(screen.getByRole("navigation", { name: "当前文件路径" })).toHaveTextContent("projectsrcapp.tsx");
    expect(screen.queryByRole("tab", { name: "切换到文件 src/app.tsx" })).not.toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox", { name: "搜索工作区文件" }));
    await user.click(screen.getByRole("button", { name: "刷新文件树" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  });

  it("offers path, browser, reveal, and delete actions from a tree item context menu", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const fetchMock = installFetchMock();
    const onOpenInBrowser = vi.fn();
    const onEntryDeleted = vi.fn();
    const showItemInFolder = vi.fn().mockResolvedValue(undefined);
    window.squadflowDesktopShell = { showItemInFolder };
    render(
      <WorkspaceFilesPanel
        flowId="flow-menu"
        rootPath="/tmp/project"
        treeAvailable
        onOpenInBrowser={onOpenInBrowser}
        onEntryDeleted={onEntryDeleted}
      />,
    );

    const file = await screen.findByRole("treeitem", { name: "打开文件 README.md" });
    fireEvent.contextMenu(file, { clientX: 120, clientY: 80 });
    await user.click(screen.getByRole("menuitem", { name: "复制相对路径" }));
    expect(writeText).toHaveBeenLastCalledWith("README.md");

    fireEvent.contextMenu(file, { clientX: 120, clientY: 80 });
    await user.click(screen.getByRole("menuitem", { name: "复制文件名" }));
    expect(writeText).toHaveBeenLastCalledWith("README.md");

    fireEvent.contextMenu(file, { clientX: 120, clientY: 80 });
    await user.click(screen.getByRole("menuitem", { name: "在内置浏览器打开" }));
    expect(onOpenInBrowser).toHaveBeenCalledWith("file:///tmp/project/README.md");

    fireEvent.contextMenu(file, { clientX: 120, clientY: 80 });
    await user.click(screen.getByRole("menuitem", { name: "在文件管理器中显示" }));
    expect(showItemInFolder).toHaveBeenCalledWith("/tmp/project/README.md", false);

    fireEvent.contextMenu(file, { clientX: 120, clientY: 80 });
    await user.click(screen.getByRole("menuitem", { name: "删除文件" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/flows/flow-menu/files?path=README.md",
      expect.objectContaining({ method: "DELETE" }),
    ));
    expect(onEntryDeleted).toHaveBeenCalledWith("README.md");
  });

  it("copies every file absolute path below a selected directory", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    installFetchMock();
    render(<WorkspaceFilesPanel flowId="flow-copy" rootPath="/tmp/project" treeAvailable />);

    const directory = await screen.findByRole("treeitem", { name: "展开目录 src" });
    fireEvent.contextMenu(directory, { clientX: 100, clientY: 70 });
    await user.click(screen.getByRole("menuitem", { name: "复制全部绝对路径" }));

    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("/tmp/project/src/app.tsx"));
  });

  it("supports tree visibility, breadcrumb reveal, and keyboard resizing", async () => {
    const user = userEvent.setup();
    installFetchMock();
    render(
      <WorkspaceFilesPanel
        flowId="flow-split"
        rootPath="/tmp/project"
        treeAvailable
      />,
    );

    await user.click(await screen.findByRole("treeitem", { name: "展开目录 src" }));
    await user.click(await screen.findByRole("treeitem", { name: "打开文件 src/app.tsx" }));

    const separator = screen.getByRole("separator", { name: "调整文件树宽度" });
    expect(separator).toHaveAttribute("aria-valuenow", "320");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "340");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "320");

    await user.click(screen.getByRole("button", { name: "隐藏文件列表" }));
    expect(screen.getByTestId("workspace-files-shell")).toHaveAttribute("data-tree-visible", "false");
    expect(screen.getByTestId("workspace-file-tree")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-file-tree-drawer")).toHaveAttribute("data-state", "closed");
    expect(screen.getByTestId("workspace-file-tree-drawer")).toHaveStyle({ width: "0px" });
    expect(screen.getByRole("button", { name: "显示文件列表" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "显示文件列表" }));
    expect(screen.getByTestId("workspace-file-tree")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-file-tree-drawer")).toHaveStyle({
      width: "320px",
      minWidth: "192px",
      maxWidth: "min(60%, calc(100% - 192px))",
    });
  });

  it("keeps the file tree stable while preserving a matching preview minimum", async () => {
    installFetchMock();
    render(
      <WorkspaceFilesPanel
        flowId="flow-ratio"
        rootPath="/tmp/project"
        treeAvailable
      />,
    );

    await screen.findByRole("treeitem", { name: "展开目录 src" });
    const separator = screen.getByRole("separator", { name: "调整文件树宽度" });
    const split = separator.parentElement;
    expect(split).not.toBeNull();
    Object.defineProperty(split, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        right: 1000,
        width: 1000,
        top: 0,
        bottom: 600,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => {},
      }),
    });

    fireEvent.pointerDown(separator, { button: 0, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 200 });
    await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "600"));

    fireEvent.pointerMove(window, { clientX: 700 });
    await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "300"));
    fireEvent.pointerUp(window);
  });

  it("keeps the file tree width shared when switching flows", async () => {
    installFetchMock();
    const { rerender } = render(
      <WorkspaceFilesPanel
        flowId="flow-width-a"
        rootPath="/tmp/project"
        treeAvailable
      />,
    );

    await screen.findByRole("treeitem", { name: "展开目录 src" });
    const separator = screen.getByRole("separator", { name: "调整文件树宽度" });
    const split = separator.parentElement;
    expect(split).not.toBeNull();
    Object.defineProperty(split, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        right: 1000,
        width: 1000,
        top: 0,
        bottom: 600,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => {},
      }),
    });

    fireEvent.pointerDown(separator, { button: 0, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 200 });
    await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "600"));
    fireEvent.pointerUp(window);
    expect(localStorage.getItem(WORKSPACE_FILE_TREE_WIDTH_STORAGE_KEY)).toBe("600");

    rerender(
      <WorkspaceFilesPanel
        flowId="flow-width-b"
        rootPath="/tmp/project"
        treeAvailable
      />,
    );

    expect(screen.getByRole("separator", { name: "调整文件树宽度" })).toHaveAttribute("aria-valuenow", "600");
    expect(screen.getByTestId("workspace-file-tree-drawer")).toHaveStyle({ width: "600px" });
  });

  it("collapses the file tree immediately when dragged past seventy percent of its minimum width", async () => {
    installFetchMock();
    render(
      <WorkspaceFilesPanel
        flowId="flow-force-collapse"
        rootPath="/tmp/project"
        treeAvailable
      />,
    );

    await screen.findByRole("treeitem", { name: "展开目录 src" });
    const separator = screen.getByRole("separator", { name: "调整文件树宽度" });
    const split = separator.parentElement;
    expect(split).not.toBeNull();
    Object.defineProperty(split, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        right: 1000,
        width: 1000,
        top: 0,
        bottom: 600,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => {},
      }),
    });

    fireEvent.pointerDown(separator, { button: 0, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 950 });

    await waitFor(() => {
      expect(screen.getByTestId("workspace-files-shell")).toHaveAttribute("data-tree-visible", "false");
    });
    expect(screen.getByTestId("workspace-file-tree-drawer")).toHaveAttribute("data-state", "closed");
  });

  it("keeps the empty preview and file tree in the same split layout", async () => {
    const user = userEvent.setup();
    installFetchMock();
    render(
      <WorkspaceFilesPanel
        flowId="flow-close"
        rootPath="/tmp/project"
        treeAvailable
      />,
    );

    await screen.findByRole("treeitem", { name: "打开文件 README.md" });

    expect(screen.queryByTestId("mock-file-preview")).not.toBeInTheDocument();
    expect(screen.getByText("从工作区目录树中选择文件")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-file-preview-pane")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-file-preview-pane")).toHaveStyle({ minWidth: "192px" });
    expect(screen.getByTestId("workspace-file-tree")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-file-tree-drawer")).toHaveStyle({
      width: "320px",
      minWidth: "192px",
      maxWidth: "min(60%, calc(100% - 192px))",
    });

    await user.click(screen.getByRole("button", { name: "隐藏文件列表" }));
    expect(screen.getByText("从工作区目录树中选择文件")).toBeInTheDocument();
    expect(within(screen.getByTestId("workspace-file-preview-pane")).getAllByText("打开文件")).toHaveLength(1);
    expect(screen.getByTestId("workspace-file-tree-drawer")).toHaveStyle({ width: "0px" });
  });
});
