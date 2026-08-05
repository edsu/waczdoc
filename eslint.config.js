import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Source runs in Node, but page.evaluate() callbacks reference browser
    // globals (document, window, setTimeout), so allow both.
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // Tests are plain ESM JS run by node:test.
    files: ["test/**/*.js"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Example injection snippets run in the browser (the replayed page).
    files: ["examples/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  }
);
