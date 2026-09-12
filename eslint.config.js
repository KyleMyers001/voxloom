import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      ".playwright-browsers",
      "dist",
      "playwright-report",
      "playwright-report-release",
      "src-tauri/target",
      "test-results",
      "test-results-release",
    ],
  },
);
