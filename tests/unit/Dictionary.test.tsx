import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Dictionary } from "../../src/features/dictionary/Dictionary";
import { renderWithApp } from "./testUtils";

describe("Dictionary", () => {
  it("supports Word CRUD, filtering, and accessible errors", async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    await user.click(screen.getByRole("button", { name: "Add term" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a word");
    await user.type(screen.getByLabelText("Word"), " typescript ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("already");
    await user.clear(screen.getByLabelText("Word"));
    await user.type(screen.getByLabelText("Word"), " Vite ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Vite")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit Vite" }));
    await user.clear(screen.getByLabelText("Word"));
    await user.type(screen.getByLabelText("Word"), "Vitest");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Vitest")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "vite");
    expect(screen.queryByText("Postgres")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete Vitest" }));
    expect(screen.getByText("No words found.")).toBeInTheDocument();
  });

  it("restores focus and supports backdrop dismissal", async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    const add = screen.getByRole("button", { name: "Add term" });
    await user.click(add);
    await user.keyboard("{Escape}");
    expect(add).toHaveFocus();
    await user.click(add);
    const dialog = screen.getByRole("dialog", {
      name: "Add dictionary word",
    });
    fireEvent.mouseDown(dialog);
    expect(dialog).not.toBeInTheDocument();
    expect(add).toHaveFocus();
  });
});
