import { defineConfig } from 'vitest/config'
import workspace from './vitest.mobile-workspace.config.mts'
import { resolve, relative } from 'node:path'
import { instrumentCreationSource } from './mobile-creation-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...workspace, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, plugins: [...(workspace.plugins ?? []), { name: 'original-mobile-creation-source', enforce: 'pre', transform(source, id) {
  const value = instrumentCreationSource(source, relative(root, id.split('?')[0]!)); return value === source ? null : value
} }],
  test: { setupFiles: ['apps/mobile/test/device-locks.ts'], include: ['apps/host/test/mobile-desktop-creation.test.tsx'], maxWorkers: 1, fileParallelism: false } })
