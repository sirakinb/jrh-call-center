import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/e2e belongs to Playwright; Vitest must not import those specs.
    include: ['tests/*.test.js'],
  },
});
