import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { AppProvider } from "../../src/app/AppContext";

export function renderWithApp(
  element: ReactElement,
  clock: () => number = () => 1_800_000_000_000,
) {
  return render(<AppProvider clock={clock}>{element}</AppProvider>);
}
