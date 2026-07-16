import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DeleteFlowModal from "./DeleteFlowModal";

describe("DeleteFlowModal", () => {
  it("closes after confirming a single flow deletion", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();

    render(
      <DeleteFlowModal
        open
        flowName="调研一下当前目录都什么"
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
