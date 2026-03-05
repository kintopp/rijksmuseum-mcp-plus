import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: false,  // no type-checked rules — fast
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "warn",
    },
    rules: {
      // Always-true/false expressions: `x ?? y || z`, `"" + value ?? fallback`
      "no-constant-binary-expression": "error",
      // Numeric literals that silently lose precision
      "no-loss-of-precision": "error",
      // Missing break in switch-case
      "no-fallthrough": "error",
      // == instead of === — "smart" allows `== null` / `!= null` (idiomatic null+undefined check)
      "eqeqeq": ["warn", "smart"],
    },
  },
  {
    ignores: ["dist/", "apps/", "scripts/"],
  },
);
