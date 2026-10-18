import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.conversation-unified-consumers.config.mts'
import { candidateAlias, candidateModule } from '../scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_SYSTEM_AUTHOR_MUTATION
const owner = 'packages/core/src/conversation-stream.ts'
const branch = "if (record.original.item.kind === 'system_message' && record.original.item.source === 'agentmux') return { kind: 'system' }"
const edits: Record<string, [string, string]> = {
  'ignore-system-author': [branch, '/* Source mutation: no recorded AgentMux system fallback. */'],
  'trust-foreign-system-source': [branch, "if (record.original.item.kind === 'system_message') return { kind: 'system' }"]
}
if (mutation && !edits[mutation]) throw Error('Unknown system-author source mutation')
export default defineConfig({ ...base, root, cacheDir: resolve(root, '.cache/conversation-system-author-' + (mutation ?? 'base')),
  resolve: { ...base.resolve, alias: [candidateAlias(root, { source: true, browser: true }),
    ...(Array.isArray(base.resolve?.alias) ? base.resolve.alias : [])] },
  plugins: [{ name: 'actual-system-author-source', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    const path = relative(root, actual)
    let code = source
    if (mutation && path === owner) {
      const [from, to] = edits[mutation]!
      if (source.split(from).length !== 2) throw Error('Expected one exact Core author mutation')
      code = source.replace(from, to)
    }
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_SYSTEM_AUTHOR_LOADED) appendFileSync(process.env.AGENTMUX_SYSTEM_AUTHOR_LOADED,
      JSON.stringify({ path, fileSHA256: hash(readFileSync(actual)), originalSHA256: hash(source),
        loadedSHA256: hash(code), mutation: code === source ? null : mutation }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/conversation-system-context.integration.test.tsx',
    'apps/desktop/test/conversation-system-lines.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
