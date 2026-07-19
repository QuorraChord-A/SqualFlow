import { render, screen } from "@testing-library/react";
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

  it("keeps Markdown table content visible when table controls are disabled", () => {
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
});
