import { render, screen } from "@testing-library/react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, __selectTestUtils } from "./select";

it("SelectTrigger uses >=16px font-size on mobile to avoid iOS Safari auto-zoom", () => {
  render(
    <Select defaultValue="a">
      <SelectTrigger aria-label="Test select">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="a">A</SelectItem>
      </SelectContent>
    </Select>,
  );

  const trigger = screen.getByLabelText("Test select");
  expect(trigger).toHaveClass("text-[16px]");
  expect(trigger).toHaveClass("sm:text-sm");
});

it("finds nearest scrollable ancestor for stable dropdown close", () => {
  const container = document.createElement("div");
  const middle = document.createElement("div");
  const trigger = document.createElement("button");

  Object.defineProperty(container, "scrollHeight", { configurable: true, value: 600 });
  Object.defineProperty(container, "clientHeight", { configurable: true, value: 200 });
  Object.defineProperty(container, "scrollWidth", { configurable: true, value: 300 });
  Object.defineProperty(container, "clientWidth", { configurable: true, value: 300 });
  container.style.overflowY = "auto";

  document.body.appendChild(container);
  container.appendChild(middle);
  middle.appendChild(trigger);

  expect(__selectTestUtils.findScrollableAncestor(trigger)).toBe(container);
});

it("restores both container and window scroll positions", () => {
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  const windowScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

  const container = document.createElement("div");
  const containerScroll = vi.fn();
  Object.defineProperty(container, "scrollTo", {
    configurable: true,
    value: containerScroll,
  });
  document.body.appendChild(container);

  __selectTestUtils.restoreScrollSnapshot({
    windowX: 11,
    windowY: 22,
    container,
    containerLeft: 33,
    containerTop: 44,
  });

  expect(containerScroll).toHaveBeenCalledWith(33, 44);
  expect(windowScroll).toHaveBeenCalledWith(11, 22);

  raf.mockRestore();
  windowScroll.mockRestore();
});
