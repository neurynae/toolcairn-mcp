import type { ConfigAuditEntry, ToolPilotProjectConfig } from '@toolcairn/types';
import { appendAudit, bulkAppendAudit } from './audit.js';

export interface MigrateResult {
  migrated: boolean;
  /** True iff the doc was at version 1.0 and was upgraded in place. */
  was_v1_0: boolean;
  /** True iff the doc was at v1.1 and was upgraded to v1.2. */
  was_v1_1?: boolean;
  /** Legacy audit entries that were moved out of the config into audit-log.jsonl. */
  legacy_audit_entries: ConfigAuditEntry[];
}

/**
 * Migrates a parsed config in place from v1.0 to v1.1.
 *
 * - Promotes `project.language` (string) to `project.languages` (array).
 * - Promotes `project.framework` (string) to `project.frameworks` (array).
 * - Ensures every ConfirmedTool has `locations: []` (empty by default — re-scan
 *   fills in accurate data on the first toolcairn_init after upgrade).
 * - Relocates inline `audit_log[]` into audit-log.jsonl and drops the field from
 *   the in-memory config.
 *
 * Does NOT write to disk — caller (mutate.ts) is responsible for the atomic write
 * and for bulk-appending the returned `legacy_audit_entries` to audit-log.jsonl.
 */
export async function migrateToV1_1(
  config: ToolPilotProjectConfig,
  projectRoot: string,
): Promise<MigrateResult> {
  if (config.version === '1.1' || config.version === '1.2') {
    // Already on v1.1 or beyond — just make sure locations[] exists so handlers
    // can rely on it being present.
    for (const tool of config.tools.confirmed) {
      if (!tool.locations) tool.locations = [];
    }
    return { migrated: false, was_v1_0: false, legacy_audit_entries: [] };
  }

  // Upgrade project metadata.
  if (!config.project.languages) {
    config.project.languages = config.project.language
      ? [{ name: config.project.language, file_count: 0, workspaces: ['.'] }]
      : [];
  }
  if (!config.project.frameworks) {
    config.project.frameworks = config.project.framework
      ? [
          {
            name: config.project.framework,
            ecosystem: 'npm',
            workspace: '.',
            source: 'local',
          },
        ]
      : [];
  }
  if (!config.project.subprojects) config.project.subprojects = [];

  // Every ConfirmedTool gets a locations[] (empty placeholder — first re-scan fills it).
  for (const tool of config.tools.confirmed) {
    if (!tool.locations) tool.locations = [];
  }

  // Extract legacy audit entries + append migration marker.
  const legacy = config.audit_log ?? [];
  delete config.audit_log;

  const now = new Date().toISOString();
  const migrationEntry: ConfigAuditEntry = {
    action: 'migrate',
    tool: '__schema__',
    timestamp: now,
    reason:
      'Schema 1.0 → 1.1: audit_log relocated to audit-log.jsonl; languages/frameworks expanded to arrays',
  };
  config.last_audit_entry = migrationEntry;
  config.version = '1.1';

  // Persist legacy entries + the migration entry into the audit-log.jsonl file.
  // (The mutate.ts orchestration still holds the cross-process lock at this point.)
  await bulkAppendAudit(projectRoot, [...legacy, migrationEntry]);

  return { migrated: true, was_v1_0: true, legacy_audit_entries: legacy };
}

/**
 * Migrates a parsed config in place from v1.1 to v1.2.
 *
 * Adds `tools.unknown_in_graph: []` if missing. Intended as an additive, non-destructive
 * step so reading a v1.1 config under the new runtime just gains the new field.
 *
 * Does NOT write to disk — caller (mutate.ts) holds the lock + does the atomic write.
 */
export async function migrateToV1_2(
  config: ToolPilotProjectConfig,
  projectRoot: string,
): Promise<{ migrated: boolean }> {
  if (config.version === '1.2') {
    if (!config.tools.unknown_in_graph) config.tools.unknown_in_graph = [];
    return { migrated: false };
  }
  if (config.version !== '1.1') {
    // Caller should always run migrateToV1_1 first; guard is defensive only.
    return { migrated: false };
  }

  if (!config.tools.unknown_in_graph) config.tools.unknown_in_graph = [];
  config.version = '1.2';

  const now = new Date().toISOString();
  const entry: ConfigAuditEntry = {
    action: 'migrate',
    tool: '__schema__',
    timestamp: now,
    reason: 'Schema 1.1 → 1.2: added tools.unknown_in_graph for suggest_graph_update drain tracking',
  };
  config.last_audit_entry = entry;
  await appendAudit(projectRoot, entry);

  return { migrated: true };
}
