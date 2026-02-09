import { render, screen } from "@testing-library/react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";

it("DialogContent keeps mobile-friendly margins/scroll + safe-area close button", async () => {
  render(
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Desc</DialogDescription>
        </DialogHeader>
        <div>Body</div>
      </DialogContent>
    </Dialog>,
  );

  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveClass("w-[calc(100%-2rem)]");
  expect(dialog).toHaveClass("max-h-[85dvh]");
  expect(dialog).toHaveClass("sm:w-full");

  const close = screen.getByRole("button", { name: "Schließen" });
  expect(close).toHaveClass("right-[calc(0.5rem+env(safe-area-inset-right))]");
  expect(close).toHaveClass("top-[calc(0.5rem+env(safe-area-inset-top))]");
});
