import { createMcpLogger } from '@toolcairn/errors';
import { type PendingAuditEntry, mutateConfig } from '../config-store/index.js';
import { type BatchResolveFn, scanProject } from '../discovery/index.js';
import {
  type AgentType,
  getInstructionsForAgent,
  getMcpConfigEntry,
  getOpenCodeMcpEntry,
} from '../templates/agent-instructions.js';
import { errResult, okResult } from '../utils.js';

const logger = createMcpLogger({ name: '@toolcairn/tools:toolcairn-init' });

export interface HandleToolcairnInitDeps {
  /** Injected resolver — the server wires this to ToolCairnClient.batchResolve. */
  batchResolve?: BatchResolveFn;
}

/**
 * One-call project setup for the ToolCairn MCP.
 *
 * Does ALL of the following server-side:
 *   1. Walks every workspace (pnpm/yarn/cargo/go-work/nx/lerna/turbo), depth-capped.
 *   2. Parses every manifest + lockfile across 12 ecosystems.
 *   3. Calls the engine batch-resolve endpoint to classify which tools are
 *      indexed in the ToolCairn graph (source: "toolcairn") vs local-only (source: "non_oss").
 *   4. Detects primary languages by file-extension count.
 *   5. Detects frameworks using graph categories (primary) + offline fallback map.
 *   6. Atomically writes `.toolcairn/config.json` (v1.1 schema) + appends to
 *      `.toolcairn/audit-log.jsonl`. Cross-process locked.
 *
 * Still returns `setup_steps` for the agent to execute — but ONLY for files the
 * MCP server has no business touching:
 *   - CLAUDE.md / .cursorrules / etc. (user-maintained instruction docs)
 *   - .mcp.json (user-maintained client config)
 *   - .gitignore (user-maintained)
 */
export async function handleToolcairnInit(
  args: {
    agent: AgentType;
    project_root: string;
    server_path?: string;
  },
  deps: HandleToolcairnInitDeps = {},
) {
  try {
    logger.info({ agent: args.agent, project_root: args.project_root }, 'toolcairn_init called');

    // 1. Programmatic scan + server-side config write.
    const scan = await scanProject(args.project_root, { batchResolve: deps.batchResolve });

    const audit: PendingAuditEntry = {
      action: 'init',
      tool: '__project__',
      reason: `Auto-discovered via toolcairn_init: ${scan.tools.length} tools across ${scan.scan_metadata.ecosystems_scanned.length} ecosystems`,
    };

    const { config, audit_entry, bootstrapped, migrated } = await mutateConfig(
      args.project_root,
      (cfg) => {
        cfg.project.name = scan.name;
        cfg.project.languages = scan.languages;
        cfg.project.frameworks = scan.frameworks;
        cfg.project.subprojects = scan.subprojects;
        // Replace the whole confirmed list — init is authoritative.
        cfg.tools.confirmed = scan.tools;
        cfg.scan_metadata = scan.scan_metadata;
      },
      audit,
    );

    // 2. Agent-side setup steps (instruction doc + .mcp.json + .gitignore)
    const instructions = getInstructionsForAgent(args.agent);
    const isOpenCode = args.agent === 'opencode';
    const mcpConfigEntry = isOpenCode
      ? getOpenCodeMcpEntry(args.server_path)
      : getMcpConfigEntry(args.server_path);
    const mcpConfigFile = isOpenCode ? 'opencode.json' : '.mcp.json';

    const mcpContent = isOpenCode
      ? JSON.stringify({ mcp: mcpConfigEntry }, null, 2)
      : JSON.stringify({ mcpServers: mcpConfigEntry }, null, 2);

    const setupSteps = [
      {
        step: 1,
        action: 'append-or-create',
        file: instructions.file_path,
        content: instructions.content,
        note: `Append the ToolCairn rules block to ${instructions.file_path} (or create it if missing).`,
      },
      {
        step: 2,
        action: 'merge-or-create',
        file: mcpConfigFile,
        content: mcpContent,
        note: isOpenCode
          ? `Merge the toolcairn entry into ${mcpConfigFile} under "mcp".`
          : `Merge the toolcairn entry into ${mcpConfigFile} under "mcpServers".`,
      },
      {
        step: 3,
        action: 'append',
        file: '.gitignore',
        content:
          '\n# ToolCairn\n.toolcairn/events.jsonl\n.toolcairn/audit-log.jsonl\n.toolcairn/audit-log.archive.jsonl\n.toolcairn/config.lock\n',
        note: 'Ignore runtime/audit files. config.json should be committed so teammates share tool intelligence.',
      },
    ];

    const tool_counts = {
      total: config.tools.confirmed.length,
      indexed: config.tools.confirmed.filter((t) => t.source === 'toolcairn').length,
      non_oss: config.tools.confirmed.filter((t) => t.source === 'non_oss').length,
    };

    return okResult({
      agent: args.agent,
      instruction_file: instructions.file_path,
      config_path: '.toolcairn/config.json',
      audit_log_path: '.toolcairn/audit-log.jsonl',
      events_path: '.toolcairn/events.jsonl',
      mcp_config_entry: mcpConfigEntry,
      setup_steps: setupSteps,
      scan_summary: {
        project_name: scan.name,
        languages: scan.languages.map((l) => ({ name: l.name, file_count: l.file_count })),
        frameworks: scan.frameworks,
        subprojects: scan.subprojects,
        tool_counts,
        warnings: scan.warnings,
        scan_metadata: scan.scan_metadata,
      },
      bootstrapped,
      migrated,
      last_audit_entry: audit_entry,
      next_steps:
        'Config written. Apply the setup_steps above (CLAUDE.md rules + .mcp.json merge + .gitignore). Then proceed with normal tool calls — the server owns .toolcairn/ going forward.',
    });
  } catch (e) {
    logger.error({ err: e }, 'toolcairn_init failed');
    return errResult('init_error', e instanceof Error ? e.message : String(e));
  }
}
