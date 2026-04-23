export { scanProject } from './scan-project.js';
export type {
  BatchResolveFn,
  ScanProjectOptions,
  ScanProjectResult,
} from './scan-project.js';
export type { BatchResolveResult } from './frameworks/detect.js';
export type { DetectedTool, ParseResult, Parser, ParserInput } from './types.js';
export {
  discoverProjectRoots,
  type DiscoverRootsOptions,
  type DiscoverRootsResult,
} from './discover-roots.js';
