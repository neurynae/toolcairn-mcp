import { describe, expect, it } from 'vitest';
import { mergeInstructionBlock } from '../src/auto-init.js';

const BLOCK = `<!-- toolcairn:start -->
### ToolCairn (tool-intelligence MCP)
hello
<!-- toolcairn:end -->`;

describe('mergeInstructionBlock', () => {
  it('writes the block as full content when the file does not exist', () => {
    const out = mergeInstructionBlock('', false, BLOCK);
    expect(out).toBe(BLOCK);
  });

  it('writes the block as full content when the file is empty', () => {
    const out = mergeInstructionBlock('', true, BLOCK);
    expect(out).toBe(BLOCK);
  });

  it('replaces ONLY the marker block in place', () => {
    const existing = `# Project rules

We use TypeScript strict mode.

<!-- toolcairn:start -->
old content
<!-- toolcairn:end -->

## More project rules

End-of-file.`;
    const out = mergeInstructionBlock(existing, true, BLOCK);
    expect(out).toContain('# Project rules');
    expect(out).toContain('We use TypeScript strict mode.');
    expect(out).toContain('## More project rules');
    expect(out).toContain('End-of-file.');
    expect(out).toContain(BLOCK);
    expect(out).not.toContain('old content');
  });

  it('migrates legacy v0.10.x unmanaged heading by stripping from heading to EOF', () => {
    const existing = `# Project rules

The user's own primary instructions live here.

## ToolCairn MCP — Tool Intelligence

(legacy auto-generated content, no markers, dumped at the bottom of the file in v0.10.x)
- a rule
- another rule
`;
    const out = mergeInstructionBlock(existing, true, BLOCK);
    expect(out).toContain('# Project rules');
    expect(out).toContain("The user's own primary instructions live here.");
    expect(out).not.toContain('## ToolCairn MCP — Tool Intelligence');
    expect(out).not.toContain('legacy auto-generated content');
    expect(out).toContain(BLOCK);
    // User content + blank line + block.
    expect(out.endsWith(BLOCK + '\n')).toBe(true);
  });

  it('appends the block to unrelated existing content with blank-line separation', () => {
    const existing = `# Project rules

We commit conventional commits.
`;
    const out = mergeInstructionBlock(existing, true, BLOCK);
    expect(out.startsWith('# Project rules')).toBe(true);
    expect(out).toContain('We commit conventional commits.');
    expect(out).toContain(BLOCK);
    expect(out).toMatch(/We commit conventional commits\.\n\n<!-- toolcairn:start -->/);
  });

  it('is idempotent on a file already holding the current block', () => {
    const existing = `# Project rules\n\n${BLOCK}\n`;
    const out = mergeInstructionBlock(existing, true, BLOCK);
    // Same block → output equals input.
    expect(out).toBe(existing);
  });

  it('does not duplicate user content when block is mid-file', () => {
    const existing = `top\n${BLOCK}\nbottom`;
    const updated = `<!-- toolcairn:start -->NEW<!-- toolcairn:end -->`;
    const out = mergeInstructionBlock(existing, true, updated);
    expect(out).toBe(`top\n${updated}\nbottom`);
  });
});
