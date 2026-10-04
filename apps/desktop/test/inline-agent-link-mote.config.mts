import { defineConfig } from 'vitest/config'
import base from '../../../vitest.config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const mutation = process.env.INLINE_MOTE_MUTATION
const mutations: Record<string, [string, string]> = {
  'drop-mote': ['const mote = identity?.mote', 'const mote = undefined'],
  'status-rederives-identity': ['label: session?.label,', 'label: String(session?.label) + String(session?.status.state),']
}
export default defineConfig({ ...base, resolve: { conditions: ['browser'] }, esbuild: { jsx: 'automatic' },
  plugins: [{ name: 'inline-mote-actual-source', enforce: 'pre', transform(source, id) {
    if (!id.split('?')[0]!.endsWith('/components/InlineAgentLink.tsx')) return
    let code = source
    if (mutation) {
      const change = mutations[mutation]
      if (!change || source.split(change[0]).length !== 2) throw new Error('Mote mutation did not match exactly one real implementation site.')
      code = source.replace(...change)
    }
    const log = process.env.INLINE_MOTE_LOADED
    if (log) appendFileSync(log, JSON.stringify({ path: 'apps/desktop/src/renderer/src/components/InlineAgentLink.tsx', mutation: mutation ?? null,
      sourceSHA: createHash('sha256').update(source).digest('hex'), loadedSHA: createHash('sha256').update(code).digest('hex') }) + '\n')
    if (code !== source) return { code, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/inline-agent-link-mote.test.tsx'], passWithNoTests: false } })
