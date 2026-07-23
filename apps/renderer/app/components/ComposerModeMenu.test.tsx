import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ComposerModeMenu from "./ComposerModeMenu";

function renderMenu(overrides: Partial<React.ComponentProps<typeof ComposerModeMenu>> = {}) {
  return render(
    <ComposerModeMenu
      specRequested={false}
      riskMode="auto_edit"
      planApproval="on"
      onSpecChange={vi.fn()}
      onRiskModeChange={vi.fn()}
      onPlanApprovalChange={vi.fn()}
      {...overrides}
    />,
  );
}

describe("ComposerModeMenu", () => {
  it("opens approval settings only after the add popover has fully closed", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: "添加消息选项" }));
    await user.click(screen.getByRole("button", { name: "编排审批设置，当前：需要批准" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("编排审批设置");
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  it("closes the approval dialog with Escape and removes its portal state", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: "添加消息选项" }));
    await user.click(screen.getByRole("button", { name: "编排审批设置，当前：需要批准" }));
    expect(await screen.findByRole("dialog")).toBeVisible();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    });
    expect(document.body).not.toHaveAttribute("inert");
  });

  it("unmounts an open approval dialog without leaving portals or inert state", async () => {
    const user = userEvent.setup();
    const { unmount } = renderMenu();

    await user.click(screen.getByRole("button", { name: "添加消息选项" }));
    await user.click(screen.getByRole("button", { name: "编排审批设置，当前：需要批准" }));
    expect(await screen.findByRole("dialog")).toBeVisible();

    unmount();

    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(document.body).not.toHaveAttribute("inert");
  });

  it("keeps full access orange in its default and hover styles", () => {
    renderMenu({ riskMode: "full_access" });

    const trigger = screen.getByRole("button", { name: "执行模式：完全访问" });
    expect(trigger.className).toContain("text-orange-700");
    expect(trigger.className).toContain("text-orange-500");
    expect(trigger.className).toContain("hover:text-orange-700");
    expect(trigger.className).toContain("hover:text-orange-500");
    expect(trigger.className).not.toContain("destructive");
  });

  it("offers image attachment in the add menu and forwards selected files", async () => {
    const user = userEvent.setup();
    const onAddImages = vi.fn();
    const { container } = renderMenu({ onAddImages });

    await user.click(screen.getByRole("button", { name: "添加消息选项" }));
    expect(screen.getByText("添加")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加图片" })).toHaveTextContent("PNG、JPEG、WebP 或 GIF");

    const file = new File(["image"], "example.png", { type: "image/png" });
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    await user.upload(input as HTMLInputElement, file);

    expect(onAddImages).toHaveBeenCalledWith([file]);
  });
});
