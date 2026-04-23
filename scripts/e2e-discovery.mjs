import { rm } from 'node:fs/promises';
import { join } from 'node:path';
/**
 * End-to-end discovery smoke test against D:\ToolPilot — runs the v0.10
 * scanProject + mutateConfig flow directly using the built dist.
 *
 * Usage: node scripts/e2e-discovery.mjs <project_root>
 */
import {
  joinAuditPath,
  joinConfigPath,
  mutateConfig,
  readConfig,
  readLiveAudit,
  scanProject,
} from '../packages/tools-local/dist/index.js';

const projectRoot = process.argv[2] || 'D:\\ToolPilot';
const fresh = process.argv.includes('--fresh');

async function main() {
  if (fresh) {
    const toolcairnDir = join(projectRoot, '.toolcairn');
    await rm(toolcairnDir, { recursive: true, force: true }).catch(() => {});
    console.log(`(wiped ${toolcairnDir})\n`);
  } else {
    console.log(
      '(preserving existing .toolcairn/ — migration path will engage if config is v1.0)\n',
    );
  }

  console.log(`\n=== scanProject(${projectRoot}) ===`);
  const scan = await scanProject(projectRoot);
  console.log({
    name: scan.name,
    ecosystems_scanned: scan.scan_metadata.ecosystems_scanned,
    subprojects: scan.subprojects.length,
    tools: scan.tools.length,
    languages: scan.languages.map((l) => ({ name: l.name, count: l.file_count })).slice(0, 5),
    frameworks: scan.frameworks,
    warnings: scan.warnings.length,
    duration_ms: scan.scan_metadata.duration_ms,
  });

  console.log('\n=== mutateConfig (init) ===');
  const result = await mutateConfig(
    projectRoot,
    (cfg) => {
      cfg.project.name = scan.name;
      cfg.project.languages = scan.languages;
      cfg.project.frameworks = scan.frameworks;
      cfg.project.subprojects = scan.subprojects;
      cfg.tools.confirmed = scan.tools;
      cfg.scan_metadata = scan.scan_metadata;
    },
    { action: 'init', tool: '__project__', reason: 'E2E smoke test' },
  );
  console.log({
    bootstrapped: result.bootstrapped,
    migrated: result.migrated,
    config_version: result.config.version,
    last_audit_entry: result.audit_entry,
  });

  console.log('\n=== readConfig (round-trip) ===');
  const { config } = await readConfig(projectRoot);
  console.log({
    version: config?.version,
    name: config?.project.name,
    languages: config?.project.languages?.slice(0, 3),
    frameworks: config?.project.frameworks,
    tool_count: config?.tools.confirmed.length,
    last_audit: config?.last_audit_entry,
  });

  console.log('\n=== audit-log.jsonl ===');
  const audit = await readLiveAudit(projectRoot);
  console.log(`entries: ${audit.length}`);
  console.log(audit);

  console.log('\n=== paths ===');
  console.log('config:', joinConfigPath(projectRoot));
  console.log('audit:', joinAuditPath(projectRoot));
}

main().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
