import { render, screen } from "@testing-library/react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

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

