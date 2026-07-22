import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ToolDetail from "./ToolDetail";
import type { ToolPresentation } from "./types";

describe("ToolDetail", () => {
  it("renders Write/Edit fragments with one local line-number column", () => {
    const presentation: ToolPresentation = {
      kind: "edit",
      icon: "edit",
      status: "completed",
      statusLabel: "已完成",
      title: "编辑 notes.md",
      operationLabel: "编辑",
      diff: { additions: 1, deletions: 1 },
      detailRows: [],
      rawInput: {
        old_string: "旧内容",
        new_string: "新内容",
      },
      rawOutput: null,
    };

    const { container } = render(<ToolDetail presentation={presentation} />);

    expect(container.querySelector('[data-line-numbers="single"]')).toBeInTheDocument();
    for (const row of container.querySelectorAll("[data-diff-kind]")) {
      expect(row.querySelectorAll("[data-diff-line-number]")).toHaveLength(1);
    }
  });
});
