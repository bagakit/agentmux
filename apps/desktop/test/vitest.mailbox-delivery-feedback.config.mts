import base from './vitest.mailbox-input-projection.config.mts'
import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const host = JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8'))
const aliases = Object.entries(host.exports).map(([key, value]) => ({
  find: `@agentmux/host${key.slice(1)}`, replacement: resolve(root, 'apps/host', (value as { import: string }).import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
}))
export default defineConfig({ ...base, cacheDir: '.cache/mailbox-delivery-feedback', resolve: { ...base.resolve, alias: [...aliases, ...(base.resolve!.alias as [])] }, test: { ...base.test,
  include: ['apps/desktop/test/session-mailbox-delivery-feedback.test.tsx', 'packages/client-ui/test/message-delivery-failure.test.tsx'] } })
