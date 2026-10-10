import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const target = 'packages/core/src/providers/codex-saved-history.ts'
const mutations: Record<string, [string, string]> = {
  'drop-time': ['{ startedAt: timestamp }', '{ timestamp }'],
  'drop-message-turn': [' : directTurnId ?? messageTurnId', ' : directTurnId'],
  'ignore-turn-conflict': ['directTurnId && messageTurnId && directTurnId !== messageTurnId', 'false']
}
export default defineConfig({ ...original, root, plugins: [...(original.plugins ?? []), {
  name: 'saved-metadata-original-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return
    let code = source
    const mutation = process.env.SAVED_METADATA_MUTATION
    if (mutation) {
      const edit = mutations[mutation]; assert.ok(edit, 'Known semantic mutation')
      if (path === target) {
        assert.equal(source.split(edit[0]).length, 2, 'Unique original implementation anchor')
        code = source.replace(edit[0], edit[1])
      }
    }
    const output = process.env.SAVED_METADATA_LOADED
    if (output) appendFileSync(output, JSON.stringify({ path, sourceSHA256: createHash('sha256').update(source).digest('hex'),
      loadedSHA256: createHash('sha256').update(code).digest('hex'), transformed: source !== code, mutation }) + '\n')
    if (source !== code) return { code, map: null }
  }
}], test: { ...original.test, globalSetup: [], include: ['packages/core/test/codex-saved-history-metadata.test.ts'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
