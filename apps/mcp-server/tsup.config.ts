/**
 * tsup bundle config for the published @toolcairn/mcp npm package.
 *
 * Entry point: src/index.ts (which uses server.prod.ts in production mode)
 * Output: dist-publish/index.js — a single bundled ESM file
 *
 * All @toolcairn/* workspace packages are bundled inline.
 * @modelcontextprotocol/sdk is kept external (peer dep, already bundled by it).
 * Node built-ins are not bundled.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  // Use the production-only entry — excludes dev-mode DB packages from the bundle
  entry: { index: 'src/index.prod.ts' },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  bundle: true,
  // Sourcemap intentionally OFF for the published bundle — the .map file
  // nearly doubles the npm tarball size (~470KB on top of ~240KB code) and
  // is never used at runtime, only for human debugging. With `@latest` in
  // .mcp.json, every fresh publish forces npx to download the new tarball
  // before the MCP startup timeout fires; halving the download fits cold
  // reconnects inside Claude Code's ~10s window.
  sourcemap: false,
  // Minify the bundle — drops comments + whitespace + dead code.
  // The bundled output isn't human-read at runtime; smaller = faster
  // tarball download.
  minify: true,
  clean: true,
  // tsup's built-in shims for __dirname/__filename (ESM doesn't have them).
  shims: true,
  // Inject createRequire so bundled CJS workspace packages (e.g. @toolcairn/config
  // which compiles to CJS with require('zod')) work in this ESM bundle.
  // tsup's built-in __require shim checks `typeof require !== 'undefined'`;
  // this banner creates that require function at module scope.
  banner: {
    js: "import { createRequire as __nodeCreateRequire } from 'module'; const require = __nodeCreateRequire(import.meta.url);",
  },
  // Zero externals — every runtime dep is bundled into dist/index.js.
  // Why: with `@latest` in .mcp.json and a fresh publish, npx resolves
  // the version, downloads the tarball, then npm-installs the dep tree.
  // 116 transitive packages took ~29s end-to-end on a slow connection —
  // way past Claude Code's MCP startup window. Bundling everything
  // collapses install to a single tarball extract: 1 file, 0 deps,
  // sub-second cold start.
  //
  // Note: pino was switched to synchronous stderr writes in v0.10.16
  // (no `pino.transport({...})` worker thread) so it can be statically
  // bundled here.
  external: [],
  noExternal: [/.*/],
  // Ensure node: imports work
  platform: 'node',
});
