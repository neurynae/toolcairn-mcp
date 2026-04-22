import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    testTimeout: 15_000,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
