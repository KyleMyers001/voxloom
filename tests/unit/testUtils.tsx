import type { ReactElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { AppProvider } from "../../src/app/AppContext";

export function renderWithApp(
  element: ReactElement,
  clock: () => number = () => 1_800_000_000_000,
): RenderResult {
  return render(<AppProvider clock={clock}>{element}</AppProvider>);
}
