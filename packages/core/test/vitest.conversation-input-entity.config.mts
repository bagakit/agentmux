import base from './vitest.native-adoption.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..'), owner = 'packages/core/src/conversation.ts'
const edits: Record<string, [string, string]> = {
  'raw-input-identity': ['...primary, id: record.id,', '...primary, id: primary.id,'],
  'raw-input-author': ["author: event.author.kind === 'system' ? { kind: 'unknown' as const } : event.author,", 'author: primary.author,'],
  'forget-adopted-entity': ['next.event.coalesces?.some(edge => edge.fromEventIds.includes(prior.event.id))', 'false'],
  'forget-input-scope': ['sameScope(prior, next) &&', 'true &&'],
  'shared-record-identity': ['prior.id === next.id || next.event.coalesces?.some(edge => edge.fromEventIds.includes(prior.event.id))',
    'prior.records.some(record => next.records.some(current => current.id === record.id))']
}
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/conversation-input-entity'), plugins: [...base.plugins ?? [], {
  name: 'conversation-input-entity-loaded-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== owner) return
    let code = source
    const mutation = process.env.AGENTMUX_INPUT_ENTITY_MUTATION
    if (mutation) {
      const edit = edits[mutation]
      if (!edit || source.split(edit[0]).length !== 2) throw Error('Missing unique input entity mutation target: ' + mutation)
      code = source.replace(...edit)
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_INPUT_ENTITY_LOADED) appendFileSync(process.env.AGENTMUX_INPUT_ENTITY_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), bytes: Buffer.byteLength(code), ...(source === code ? {} : { mutation }) }) + '\n')
    return source === code ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/conversation-input-entity.test.ts'], environment: 'node', passWithNoTests: false, fileParallelism: false, testTimeout: 15000 } })
