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
      "src-tauri/target",
      "test-results",
    ],
  },
);
