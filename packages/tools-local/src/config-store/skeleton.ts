import type { ToolPilotProjectConfig } from '@toolcairn/types';

/** A fresh, empty v1.2 config. Used when bootstrapping a project for the first time. */
export function emptySkeleton(name = ''): ToolPilotProjectConfig {
  return {
    version: '1.2',
    project: {
      name,
      languages: [],
      frameworks: [],
      subprojects: [],
    },
    tools: {
      confirmed: [],
      pending_evaluation: [],
      unknown_in_graph: [],
    },
    last_audit_entry: null,
  };
}
