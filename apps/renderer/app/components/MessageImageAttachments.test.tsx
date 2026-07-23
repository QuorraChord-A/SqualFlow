import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import MessageImageAttachments from "./MessageImageAttachments";
import { useComposerImageStore } from "../stores/useComposerImageStore";

const image = {
  id: "image-1",
  kind: "image" as const,
  mediaType: "image/png" as const,
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  name: "example.png",
  addedAt: 1,
};

describe("MessageImageAttachments", () => {
  beforeEach(() => {
    useComposerImageStore.setState({
      activeFlowId: "flow-1",
      images: [image],
      imagesByFlow: { "flow-1": [image] },
    });
  });

  it("closes the enlarged preview from either the close button or blank backdrop", async () => {
    const user = userEvent.setup();
    render(<MessageImageAttachments />);

    await user.click(screen.getByRole("button", { name: "放大图片 1" }));
    expect(screen.getByRole("dialog")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "关闭图片预览" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "放大图片 1" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not close the enlarged preview when the image itself is clicked", async () => {
    const user = userEvent.setup();
    render(<MessageImageAttachments />);

    await user.click(screen.getByRole("button", { name: "放大图片 1" }));
    await user.click(screen.getByRole("img", { name: "example.png" }));

    expect(screen.getByRole("dialog")).toBeVisible();
  });
});
