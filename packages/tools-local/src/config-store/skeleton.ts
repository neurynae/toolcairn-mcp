import type { ToolPilotProjectConfig } from '@toolcairn/types';

/** A fresh, empty v1.1 config. Used when bootstrapping a project for the first time. */
export function emptySkeleton(name = ''): ToolPilotProjectConfig {
  return {
    version: '1.1',
    project: {
      name,
      languages: [],
      frameworks: [],
      subprojects: [],
    },
    tools: {
      confirmed: [],
      pending_evaluation: [],
    },
    last_audit_entry: null,
  };
}
