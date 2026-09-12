import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Dialog } from "../../src/components/Dialog";

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={(event) => {
      event.currentTarget.dataset.opener = "true";
      setOpen(true);
    }}>Open editor</button>
    {open && <Dialog label="Editor" onClose={() => setOpen(false)}
      opener={document.querySelector<HTMLElement>("[data-opener]")}>
      <h2>Editor</h2>
      <button>Last action</button>
    </Dialog>}
  </>;
}

describe("Dialog", () => {
  it("traps focus, closes with Escape, and restores its opener", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "Open editor" });
    await user.click(opener);
    const close = screen.getByRole("button", { name: "Close Editor" });
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Last action" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
