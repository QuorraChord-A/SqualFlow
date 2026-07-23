import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImagePreviewOverlay } from "./ImagePreview";

describe("ImagePreviewOverlay", () => {
  it("closes from the top-right button or blank backdrop without closing on the image", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <ImagePreviewOverlay src="data:image/png;base64,iVBORw0KGgo=" alt="网页截图" onClose={onClose} />,
    );

    await user.click(screen.getByRole("button", { name: "关闭图片预览" }));
    expect(onClose).toHaveBeenCalledOnce();

    onClose.mockClear();
    rerender(<ImagePreviewOverlay src="data:image/png;base64,iVBORw0KGgo=" alt="网页截图" onClose={onClose} />);
    await user.click(screen.getByRole("img", { name: "网页截图" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
