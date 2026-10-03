// eslint v9 flat config: @eslint/js 推荐 + typescript-eslint 推荐(仅 devDep, 运行时零依赖)
// 仓库惯例放宽: no-require-imports(lazy require 防循环依赖)、no-explicit-any(参考实现刻意直观)
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // test/*.js: CJS + node globals
    files: ["test/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly", module: "readonly", process: "readonly", console: "readonly",
        Buffer: "readonly", __dirname: "readonly", __filename: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly",
        AbortController: "readonly", AbortSignal: "readonly", fetch: "readonly",
        URL: "readonly", URLSearchParams: "readonly", ReadableStream: "readonly",
      },
    },
  },
);
