import base from './captured-process-fields.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { candidateModule } from '../../../apps/desktop/scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_NATIVE_FIELD_MUTATION ?? ''
const mutations: Record<string, { owner: string; from: string; to: string }> = {
  'tool-snapshot-identity': {
    owner: 'packages/client-ui/src/components/ConversationToolTrace.tsx',
    from: 'identity={sourceIdentity}', to: 'identity={part}'
  },
  'reasoning-snapshot-identity': {
    owner: 'packages/client-ui/src/components/ConversationReasoningTrace.tsx',
    from: 'const identity = useMemo(() => ({}), [traceId, copyIdentity, traceId === undefined && copyIdentity === undefined ? part : undefined])',
    to: 'const identity = useMemo(() => ({}), [part, traceId, copyIdentity])'
  }
}
if (mutation && !mutations[mutation]) throw new Error('Unknown native-field Copy mutation')

export default defineConfig({ ...base,
  cacheDir: '.cache/native-field-copy-' + (mutation || 'positive'),
  plugins: [...base.plugins ?? [], { name: 'native-field-copy-source-proof', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    const path = relative(root, actual), query = id.includes('?') ? id.slice(id.indexOf('?')) : ''
    const kind = !query && /\.(?:[cm]?[jt]sx?)$/u.test(path) ? 'module' : 'resource'
    const selected = mutation ? mutations[mutation] : undefined
    const applied = selected && kind === 'module' && path === selected.owner
    let loaded = source
    if (applied) {
      if (source.split(selected.from).length !== 2) throw new Error('Native-field Copy mutation must match one exact original owner site')
      loaded = source.replace(selected.from, selected.to)
    }
    if (process.env.AGENTMUX_NATIVE_FIELD_LOADED) {
      const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_NATIVE_FIELD_LOADED, JSON.stringify({ path, kind, query,
        fileSHA256: sha(readFileSync(actual)), originalSHA256: sha(source), loadedSHA256: sha(loaded),
        mutation: applied ? mutation : null }) + '\n')
    }
    return applied ? loaded : undefined
  } }],
  test: { ...base.test, environment: 'happy-dom',
    include: ['packages/client-ui/test/conversation-detail-copy.test.tsx', 'apps/desktop/test/conversation-tool-payload-reading.test.tsx'],
    fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 20_000 }
})
