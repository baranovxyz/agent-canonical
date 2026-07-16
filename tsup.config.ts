import { defineConfig } from "tsup";

/**
 * Build the published artifact (agent-canonical as an npm-publishable package,
 * without changing source-checkout consumption).
 *
 * Source-checkout consumers keep resolving the TypeScript source via the
 * top-level `exports` map and inline it with their own tsup `noExternal`, so
 * development and build flows are unchanged. Publication swaps the exports
 * map to `dist` (see `publishConfig.exports` in package.json), and that dist is
 * what this config emits.
 *
 * One entry per subpath export, so the published `dist` tree mirrors the
 * `publishConfig.exports` paths exactly (`dist/schemas/index.js`,
 * `dist/parsers/claude-code/index.js`, …).
 */
export default defineConfig({
  entry: {
    "schemas/index": "src/schemas/index.ts",
    "dialects/index": "src/dialects/index.ts",
    "parsers/index": "src/parsers/index.ts",
    "parsers/claude-code/index": "src/parsers/claude-code/index.ts",
    "parsers/codex/index": "src/parsers/codex/index.ts",
    "parsers/opencode/index": "src/parsers/opencode/index.ts",
    "parsers/cursor/index": "src/parsers/cursor/index.ts",
    "parsers/gemini/index": "src/parsers/gemini/index.ts",
    "parsers/qwen/index": "src/parsers/qwen/index.ts",
    "parsers/kilo/index": "src/parsers/kilo/index.ts",
  },
  format: ["esm"],
  target: "node18",
  platform: "node",
  clean: true,
  dts: true,
  sourcemap: false,
  splitting: true,
  // zod is a peer dependency — never bundle it. better-sqlite3 is never
  // imported (the opencode parser takes a structural DB handle), kept external
  // defensively so a native module can never be inlined.
  external: ["zod", "better-sqlite3"],
});
