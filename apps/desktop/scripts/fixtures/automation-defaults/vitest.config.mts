import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import base from '../settings-overview/vitest.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const clientExports = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8')).exports
const clientAliases = Object.entries(clientExports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length).map(([key, value]) => {
  const target = typeof value === 'string' ? value : (value as { browser: string }).browser
  const pattern = ('@agentmux/client-ui' + (key === '.' ? '' : key.slice(1))).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '(.+)')
  return { find: new RegExp('^' + pattern + '$'), replacement: resolve(root, 'packages/client-ui', target).replace('*', '$1') }
})
export default defineConfig({ ...base, resolve: { ...base.resolve, alias: [...clientAliases, ...(base.resolve!.alias as any[])] }, test: { ...base.test, include: [
  'apps/desktop/test/automation-defaults-control.test.ts',
  'apps/desktop/test/automation-defaults.test.tsx',
  'apps/desktop/test/calendar-schedule-control.test.tsx',
  'apps/desktop/test/continuous-progress-product.test.tsx',
  'apps/desktop/test/mote-daily-ideas.test.tsx'
] } })
