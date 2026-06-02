import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.vite/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // TypeScript's type checker already flags undefined identifiers; turning
      // off no-undef avoids false positives on browser/node globals
      // (window, document, console, process).
      "no-undef": "off",
    },
  },
  {
    // The PWA service worker (plain JS served from web/public, not type-checked
    // by tsc) runs in the ServiceWorker global scope: self, caches, fetch, URL.
    files: ["web/public/**/*.js"],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },
  {
    // Build-time Node scripts (icon generator etc.) — Node globals: Buffer, etc.
    files: ["**/scripts/**/*.{js,mjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);

