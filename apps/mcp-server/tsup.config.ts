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
  // Drop comments from the bundle (~5-10% additional shrink) since the
  // bundled source isn't human-read.
  minify: false,
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
  // External = installed by npm at runtime (listed in package.json dependencies).
  // Do NOT bundle these — let Node.js resolve them normally.
  // @toolcairn/db is lazy-imported in event-logger.ts (optional DB tracking).
  // Marking external prevents @prisma/client from being bundled at all.
  external: [
    '@modelcontextprotocol/sdk',
    'pino',
    'zod',
    'write-file-atomic',
    'proper-lockfile',
    'smol-toml',
    'fast-xml-parser',
    'yaml',
  ],
  // Bundle all internal workspace packages (not on npm)
  noExternal: [/@toolcairn\/.*/],
  // Ensure node: imports work
  platform: 'node',
});
