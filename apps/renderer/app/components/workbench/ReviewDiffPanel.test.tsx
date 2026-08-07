import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { WorkRunReview } from "../../hooks/useFlowWorkbench";
import ReviewDiffPanel from "./ReviewDiffPanel";

const review: WorkRunReview = {
  flow_id: "flow-review",
  work_run_id: "turn-review",
  anchor_message_id: "msg-review-anchor",
  status: "ready",
  completed_at: "2026-07-21T00:00:00.000Z",
  totals: { files: 1, additions: 1, deletions: 1, modified: 1, added: 0, deleted: 0 },
  files: [{
    path: "src/example.ts",
    status: "modified",
    detail_status: "ready",
    additions: 1,
    deletions: 1,
    lines: [
      { kind: "removed", old_line: 1, new_line: null, text: "const value = 1;" },
      { kind: "added", old_line: null, new_line: 1, text: "const value = 2;" },
    ],
  }],
};

describe("ReviewDiffPanel", () => {
  it("uses the shared theme-aware unified diff rows", () => {
    render(<ReviewDiffPanel review={review} />);

    const addedRow = document.querySelector('[data-diff-kind="added"]');
    const removedRow = document.querySelector('[data-diff-kind="removed"]');
    expect(addedRow).toHaveClass("bg-emerald-500/15", "text-foreground");
    expect(removedRow).toHaveClass("bg-red-500/15", "text-foreground");
    expect(within(addedRow as HTMLElement).getByText("const value = 2;")).toHaveClass("text-foreground");
    expect(addedRow?.querySelectorAll("[data-diff-line-number]")).toHaveLength(1);
  });

  it("can hide and restore the review file list from the header", async () => {
    const user = userEvent.setup();
    render(<ReviewDiffPanel review={review} />);

    expect(screen.getByTestId("review-file-list")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "隐藏文件列表" }));
    expect(screen.queryByTestId("review-file-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("review-diff-panel")).toHaveAttribute("data-file-list-visible", "false");

    await user.click(screen.getByRole("button", { name: "显示文件列表" }));
    expect(screen.getByTestId("review-file-list")).toBeInTheDocument();
  });

  it("distinguishes an empty Review from a failed Review", () => {
    const { rerender } = render(<ReviewDiffPanel review={{
      ...review,
      status: "empty",
      totals: { files: 0, additions: 0, deletions: 0, modified: 0, added: 0, deleted: 0 },
      files: [],
    }} />);
    expect(screen.getByTestId("review-diff-panel")).toHaveTextContent("本次 WorkRun 无文件变化");

    rerender(<ReviewDiffPanel review={{ ...review, status: "failed", reason: "baseline capture failed", files: [] }} />);
    expect(screen.getByTestId("review-diff-panel")).toHaveTextContent("Diff 生成失败");
    expect(screen.getByTestId("review-diff-panel")).toHaveTextContent("baseline capture failed");
  });
});
