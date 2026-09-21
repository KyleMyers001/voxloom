import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App";
import { AppProvider } from "../../src/app/AppContext";
import type { DictationRecord } from "../../src/domain/types";
import {
  createHistoryStore,
  createMemoryHistoryIo,
  serializeHistoryFile,
} from "../../src/services/history";

const durableRow: DictationRecord = {
  createdAt: 1_800_000_000_000 - 60_000,
  durationSeconds: 4,
  id: "durable-smoke-1",
  model: "whisper-tiny.en",
  recoveryExpiresAt: null,
  status: "copied",
  style: "formal",
  text: "real durable history row",
};

async function renderDurableApp(store = createHistoryStore(
  createMemoryHistoryIo(serializeHistoryFile([durableRow])),
)) {
  const user = userEvent.setup();
  render(
    <AppProvider
      clock={() => 1_800_000_000_000}
      historyPersistence={{ enabled: true, store }}
    >
      <App />
    </AppProvider>,
  );
  // Onboarding sets #root aria-hidden; dismiss before querying Home/History.
  await user.click(screen.getByRole("button", { name: "Skip" }));
  await waitFor(() => {
    expect(screen.getByText("real durable history row")).toBeInTheDocument();
  });
  return { store, user };
}

describe("DEV Reset vs durable history", () => {
  it("Keep durable history does not replace store with fixtures", async () => {
    const io = createMemoryHistoryIo(serializeHistoryFile([durableRow]));
    const store = createHistoryStore(io);
    const saveSpy = vi.spyOn(store, "save");
    const { user } = await renderDurableApp(store);

    await user.click(screen.getByRole("button", { name: "Reset session" }));

    expect(
      screen.getByRole("dialog", { name: "Reset session" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Keep durable history" }),
    );

    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(screen.getByText("real durable history row")).toBeInTheDocument();
    expect(screen.queryByText(/Make retry explicit/i)).not.toBeInTheDocument();

    await waitFor(() => {
      const fixtureWrites = saveSpy.mock.calls.filter(([records]) =>
        records.some((r) => r.id === "record-1")
      );
      expect(fixtureWrites).toHaveLength(0);
    });

    const loaded = await store.load("forever", 1_800_000_000_000);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.records.map((r) => r.id)).toEqual(["durable-smoke-1"]);
  });

  it("Wipe durable history clears store only after explicit confirm", async () => {
    const { store, user } = await renderDurableApp();

    await user.click(screen.getByRole("button", { name: "Reset session" }));
    await user.click(
      screen.getByRole("button", { name: "Wipe durable history" }),
    );

    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(
      screen.queryByText("real durable history row"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Make retry explicit/i)).not.toBeInTheDocument();
    expect(screen.getByText("No dictations yet.")).toBeInTheDocument();

    await waitFor(async () => {
      const loaded = await store.load("forever", 1_800_000_000_000);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.records).toEqual([]);
    });
  });

  it("Cancel leaves session and durable rows unchanged", async () => {
    const { user } = await renderDurableApp();

    await user.click(screen.getByRole("button", { name: "History" }));
    await user.click(screen.getByRole("button", { name: "Reset session" }));
    const dialog = screen.getByRole("dialog", { name: "Reset session" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("dialog", { name: "Reset session" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Step 1 of 3")).not.toBeInTheDocument();
    expect(screen.getByText("real durable history row")).toBeInTheDocument();
  });
});
