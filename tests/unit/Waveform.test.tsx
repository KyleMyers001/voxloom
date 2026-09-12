import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useApp } from "../../src/app/AppContext";
import { Waveform } from "../../src/components/Waveform";
import { renderWithApp } from "./testUtils";

function Harness() {
  const { dispatch, state } = useApp();
  const runId = "runId" in state.dictation ? state.dictation.runId : 0;
  return <>
    <button onClick={() => dispatch({ type: "start-dictation" })}>Start</button>
    <button onClick={() => dispatch({
      type: "set-waveform",
      value: "speaking",
    })}>Speak</button>
    <button onClick={() => dispatch({
      runId,
      type: "process-dictation",
    })}>Process</button>
    <button onClick={() => dispatch({ type: "cancel-dictation" })}>
      Cancel
    </button>
    <Waveform />
  </>;
}

describe("Waveform", () => {
  it("shows 24 segments only during listening and processing", async () => {
    const user = userEvent.setup();
    const { container } = renderWithApp(<Harness />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByRole("img"))
      .toHaveAccessibleName("silent mock waveform");
    expect(container.querySelectorAll(".wave i")).toHaveLength(24);
    await user.click(screen.getByRole("button", { name: "Speak" }));
    expect(screen.getByRole("img")).toHaveAccessibleName(
      "speaking mock waveform",
    );
    await user.click(screen.getByRole("button", { name: "Process" }));
    expect(screen.getByRole("img")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
