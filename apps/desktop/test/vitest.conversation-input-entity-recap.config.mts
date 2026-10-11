import base from './vitest.conversation-unified-consumers.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const targets = {
 'raw-input-projection': { path: 'apps/desktop/src/renderer/src/lib/session-user-messages.ts', from: 'view.reading?.inputs ?? []', to: 'view.reading?.records.flatMap(record => record.input ? [record.input] : []) ?? []' },
 'forget-coalescence': { path: 'packages/core/src/conversation.ts', from: 'next.event.coalesces?.some(edge => edge.fromEventIds.includes(prior.event.id))', to: 'false' }
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-input-entity-recap',
 plugins: [...base.plugins ?? [], { name: 'conversation-input-entity-source-proof', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!['packages/core/src/conversation.ts', 'apps/desktop/src/renderer/src/lib/session-user-messages.ts', 'apps/desktop/src/renderer/src/components/AgentInputRecap.tsx', 'apps/desktop/test/conversation-input-entity-recap.test.tsx'].includes(path)) return
  const mutation = process.env.AGENTMUX_INPUT_ENTITY_MUTATION as keyof typeof targets | undefined
  let code = source
  if (mutation) {
   const edit = targets[mutation]
   if (!edit) throw Error('Unknown input entity mutation')
   if (path === edit.path) {
    if (source.split(edit.from).length !== 2) throw Error('Missing unique input entity mutation target')
    code = source.replace(edit.from, edit.to)
   }
  }
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  if (process.env.AGENTMUX_INPUT_ENTITY_LOADED) appendFileSync(process.env.AGENTMUX_INPUT_ENTITY_LOADED,
   JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), bytes: Buffer.byteLength(code), ...(code === source ? {} : { mutation }) }) + '\n')
  return code === source ? undefined : { code, map: null }
 } }],
 test: { ...base.test, include: ['apps/desktop/test/conversation-input-entity-recap.test.tsx'], exclude: [], passWithNoTests: false, fileParallelism: false, testTimeout: 15000 } })
