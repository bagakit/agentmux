import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import workspace from './vitest.mobile-workspace.config.mts'
import { instrumentDiagnosticsSource } from './mobile-diagnostics-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...workspace, plugins: [...(workspace.plugins ?? []), { name: 'original-mobile-diagnostics-source', enforce: 'pre', transform(source, id) {
  const value = instrumentDiagnosticsSource(source, relative(root, id.split('?')[0]!)); return value === source ? null : value
} }], test: { include: ['apps/host/test/mobile-desktop-diagnostics.test.ts'], maxWorkers: 1, fileParallelism: false } })
