import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      ".cargo-local/**",
      ".playwright-browsers",
      ".target-cpal17/**",
      "dist",
      "playwright-report",
      "playwright-report-release",
      "src-tauri/target",
      "test-results",
      "test-results-release",
    ],
  },
);
