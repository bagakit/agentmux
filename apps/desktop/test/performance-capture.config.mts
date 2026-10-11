import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import source from './vitest.performance-reading.config.mts'
const inherited = source.resolve?.alias
const aliases = Array.isArray(inherited) ? inherited : Object.entries(inherited ?? {}).map(([find, replacement]) => ({ find, replacement }))
export default defineConfig({ ...source, resolve: { ...source.resolve, alias: [
  { find: /^@agentmux\/core\/control$/u, replacement: resolve(import.meta.dirname, '../../../packages/core/src/control.ts') },
  ...aliases
] }, test: { ...source.test,
  include: ['apps/desktop/test/performance-capture.test.tsx'], maxWorkers: 1 } })
