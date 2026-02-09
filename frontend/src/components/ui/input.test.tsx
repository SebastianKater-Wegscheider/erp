import { render, screen } from "@testing-library/react";

import { Input } from "./input";

it("uses >=16px font-size on mobile to avoid iOS Safari auto-zoom", () => {
  render(<Input aria-label="Test input" />);
  const el = screen.getByLabelText("Test input");
  expect(el).toHaveClass("text-[16px]");
  expect(el).toHaveClass("sm:text-sm");
});

