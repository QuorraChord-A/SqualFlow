import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AppSettingsMenu from "./AppSettingsMenu";
import { useModalStore } from "../stores/useModalStore";

describe("AppSettingsMenu", () => {
  beforeEach(() => {
    localStorage.clear();
    useModalStore.setState({ showClearAllModal: false });
  });

  it("shows a toggle for reasoning visibility and lets the user turn it off", async () => {
    const user = userEvent.setup();

    render(<AppSettingsMenu />);

    await user.click(screen.getByLabelText("设置"));

    const toggle = await screen.findByRole("menuitemcheckbox", { name: "展示思考过程" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("opens the clear-all flows confirmation from settings", async () => {
    const user = userEvent.setup();

    render(<AppSettingsMenu />);

    await user.click(screen.getByLabelText("设置"));
    await user.click(await screen.findByRole("menuitem", { name: "清除所有 Flow" }));

    expect(useModalStore.getState().showClearAllModal).toBe(true);
  });

  it("opens the full settings page from settings", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();

    render(<AppSettingsMenu onOpenSettings={onOpenSettings} />);

    await user.click(screen.getByLabelText("设置"));
    await user.click(await screen.findByRole("menuitem", { name: "打开设置" }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
