import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ReadonlyCodeView from "./ReadonlyCodeView";

describe("ReadonlyCodeView", () => {
  it("renders read-only code with an offset line range and compact height", () => {
    render(
      <ReadonlyCodeView
        ariaLabel="文件内容"
        compact
        content={"const first = 1;\nconst second = 2;"}
        language="typescript"
        maxHeight={320}
        startLine={41}
      />,
    );

    const preview = screen.getByTestId("readonly-code-view");
    expect(preview).toHaveAttribute("data-compact", "true");
    expect(preview).toHaveStyle({ maxHeight: "320px" });
    expect(preview.querySelector(".cm-lineNumbers")).toHaveTextContent("4142");
    expect(preview.querySelector(".cm-content")).toHaveAttribute("aria-label", "文件内容");
    expect(preview.querySelector(".cm-content")).toHaveAttribute("contenteditable", "false");
  });
});
