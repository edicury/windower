import {defineConfig} from 'vitest/config';

// Linked framekit packages sit outside node_modules, so Vite would inline them; keep them native
// (the bundler uses import.meta.resolve).
export default defineConfig({
  test: {include: ['test/**/*.test.ts'], server: {deps: {external: [/framekit\/packages\//]}}},
});
