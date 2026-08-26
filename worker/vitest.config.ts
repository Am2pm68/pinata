import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    silent: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
poolOptions: { threads: { singleThread: true } },
  },
});
