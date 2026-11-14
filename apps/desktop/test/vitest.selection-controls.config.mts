import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './performance-capture.config.mts'

export default defineConfig({
  ...source,
  resolve: { ...source.resolve, alias: [
    { find: /^@agentmux\/browser\/(.+)$/u, replacement: resolve(import.meta.dirname, '../../../packages/browser/src/$1.ts') },
    { find: /^@agentmux\/host\/goal-projection$/u, replacement: resolve(import.meta.dirname, '../../host/src/goal-projection.ts') },
    ...(Array.isArray(source.resolve?.alias) ? source.resolve.alias : []),
  ] },
  cacheDir: resolve(import.meta.dirname, '../../../.cache/selection-controls'),
  test: { ...source.test, include: ['apps/desktop/test/selection-controls-consumers.test.tsx'] },
})
