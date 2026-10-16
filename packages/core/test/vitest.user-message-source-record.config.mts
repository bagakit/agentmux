import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const edits: Record<string, [string, string, string]> = {
  'query-loses-original-version': ['session-history-query.ts', '...(sourceRecord ? { sourceRecord } : {})', '...{}'],
  'adapter-loses-original-version': ['conversation.ts', '...(record.reference ? { sourceRecord:', '...(false ? { sourceRecord:'],
  'codec-trusts-foreign-version': ['session-history-read-codec.ts', 'if (message.sourceRecord !== undefined)', 'if (false)']
}
const mutation = process.env.AGENTMUX_SOURCE_RECORD_MUTATION
if (mutation && !edits[mutation]) throw Error('Unknown source record mutation: ' + mutation)
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/user-message-source-record/cache', mutation ?? 'candidate'),
  plugins: [{ name: 'source-record-actual-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return
    let code = source
    if (mutation && path === 'packages/core/src/' + edits[mutation]![0]) {
      const [, before, after] = edits[mutation]!
      if (source.split(before).length !== 2) throw Error('Source record mutation anchor must be unique: ' + mutation)
      code = source.replace(before, after)
    }
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_SOURCE_RECORD_LOADED) appendFileSync(process.env.AGENTMUX_SOURCE_RECORD_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), ...(source === code ? {} : { mutation }) }) + '\n')
    return source === code ? undefined : { code, map: null }
  } }], test: { include: ['packages/core/test/user-message-source-record.test.ts', 'packages/core/test/conversation-input-entity.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, testTimeout: 20_000, hookTimeout: 20_000, maxWorkers: 1, fileParallelism: false } })
