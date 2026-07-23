import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MessageResponse } from "./message";
import { Reasoning, ReasoningContent } from "./reasoning";

describe("MessageResponse", () => {
  let style: HTMLStyleElement;

  beforeAll(() => {
    style = document.createElement("style");
    style.textContent = readFileSync(
      path.resolve(process.cwd(), "app/globals.css"),
      "utf8",
    );
    document.head.appendChild(style);
  });

  afterAll(() => style.remove());

  it("keeps Markdown table content visible and offers a compact copy control", async () => {
    const user = userEvent.setup();
    render(
      <MessageResponse>{`Before

| Expert | Specialty |
| --- | --- |
| exp-coder | Implementation |

After`}</MessageResponse>,
    );

    expect(screen.getByText("Before")).toBeVisible();
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByText("exp-coder")).toBeVisible();
    expect(screen.getByText("After")).toBeVisible();
    await user.click(screen.getByTitle("复制表格"));
    expect(screen.getByRole("button", { name: "Markdown" })).toBeVisible();
    expect(screen.getByRole("button", { name: "CSV" })).toBeVisible();
    expect(screen.getByRole("button", { name: "TSV" })).toBeVisible();
  });

  it("keeps Markdown tables visible inside reasoning content", () => {
    render(
      <Reasoning open>
        <ReasoningContent>{`| Check | Result |
| --- | --- |
| Markdown table | Visible |`}</ReasoningContent>
      </Reasoning>,
    );

    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByText("Markdown table")).toBeVisible();
  });

  it("renders standard images, math, and direct external links", () => {
    render(
      <MessageResponse>{`![示例](https://example.com/image.png)

$E = mc^2$

[GitHub](https://github.com)`}</MessageResponse>,
    );

    expect(screen.getByRole("img", { name: "示例" })).toHaveAttribute("src", "https://example.com/image.png");
    expect(document.querySelector(".katex")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", "https://github.com/");
    expect(screen.queryByText("打开外部链接？")).not.toBeInTheDocument();
  });
});
