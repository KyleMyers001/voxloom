import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Waveform, toDisplayLevel } from "../../src/components/Waveform";

const quiet = Array(24).fill(0) as number[];

describe("Waveform", () => {
  it("renders measured levels instead of a looping mock pattern", () => {
    const levels = [...quiet.slice(1), 0.6];
    const { container, rerender } = render(
      <Waveform levels={levels} waveform="silent" />,
    );
    expect(screen.getByRole("img")).toHaveAccessibleName("Microphone level");
    const bars = container.querySelectorAll<HTMLElement>(".wave i");
    expect(bars).toHaveLength(24);
    expect(bars[0].style.getPropertyValue("--h")).toBe("1px");
    expect(bars[23].style.getPropertyValue("--h")).toBe("8px");

    rerender(<Waveform levels={quiet} waveform="silent" />);
    expect(container.querySelectorAll<HTMLElement>(".wave i")[23]
      .style.getPropertyValue("--h"))
      .toBe(bars[0].style.getPropertyValue("--h"));
  });

  it("gates noise and clamps the volume before display", () => {
    expect(toDisplayLevel(0)).toBe(0);
    expect(toDisplayLevel(0.0001)).toBe(0);
    expect(toDisplayLevel(0.02)).toBeGreaterThan(0);
    expect(toDisplayLevel(0.1)).toBeGreaterThan(toDisplayLevel(0.02));
    expect(toDisplayLevel(99)).toBe(1);
    expect(toDisplayLevel(Number.NaN)).toBe(0);
  });
});
