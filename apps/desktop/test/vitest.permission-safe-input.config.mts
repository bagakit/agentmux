import { defineConfig } from 'vitest/config'
import source from '../scripts/fixtures/composer-pending-delivery/vitest.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), { name: 'permission-safe-input-owner', enforce: 'pre', transform(code, id) {
  if (!id.endsWith('/lib/interaction-native-composer-binding.ts')) return
  const original = code
  if (process.env.AGENTMUX_INTERACTION_UI_MUTATION === 'disable-native-binding') {
    const anchor = 'session.capabilities.nativeConversationInput?.interactionQueue !== true'
    if (code.split(anchor).length !== 2) throw Error('Unique native binding owner required')
    code = code.replace(anchor, 'true')
  }
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  if (process.env.AGENTMUX_INTERACTION_UI_LOADED) appendFileSync(process.env.AGENTMUX_INTERACTION_UI_LOADED, JSON.stringify({ id, originalSHA256: sha(original), sha256: sha(code), mutation: process.env.AGENTMUX_INTERACTION_UI_MUTATION }) + '\n')
  if (code !== original) return { code, map: null }
} }], test: { ...source.test, passWithNoTests: false,
  include: ['apps/desktop/test/composer-send-while-request-pending.test.ts', 'apps/desktop/test/composer-pending-interaction-geometry.test.tsx'],
  reporters: ['default'], outputFile: undefined, maxWorkers: 1 } })
