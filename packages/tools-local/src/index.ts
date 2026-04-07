/**
 * @toolcairn/tools-local
 *
 * Production-safe handlers and schemas — zero DB/search/graph dependencies.
 * Used by the published MCP server bundle (npx @neurynae/toolcairn-mcp).
 *
 * Local handlers run entirely on the user's machine.
 * Remote tool schemas are re-exported here for MCP tool registration.
 */

// Zod input schemas (all tools — needed for MCP tool registration in prod server)
export * from './schemas.js';

// Type utilities
export { okResult, errResult } from './utils.js';
export type { FormattedResult } from './format-results.js';

// Local handlers — run entirely on the user's machine, zero DB deps
export { handleClassifyPrompt } from './handlers/classify-prompt.js';
export { handleToolcairnInit } from './handlers/toolcairn-init.js';
export { handleInitProjectConfig } from './handlers/init-project-config.js';
export { handleReadProjectConfig } from './handlers/read-project-config.js';
export { handleUpdateProjectConfig } from './handlers/update-project-config.js';
