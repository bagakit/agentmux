import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import base from './vitest.conversation-native-source-integrity.config.mts'
import { candidateModule } from '../../../apps/desktop/scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { owner: string; from: string; to: string }> = {
  'omit-active-transient-binding': { owner: 'packages/core/src/client.ts',
    from: 'const active = this.activeNativeHistoryBinding(agentSessionId, source)', to: 'const active = undefined' },
  'omit-view-watch-source-qualification': { owner: 'packages/core/src/client.ts',
    from: 'if (native.source.providerId !== source.providerId || native.source.nativeSessionId !== source.nativeSessionId) {',
    to: 'if (false) {' },
  'skip-current-acquisition-after-prior': { owner: 'packages/client-ui/src/lib/use-conversation-view.ts',
    from: "if (kind === 'latest' && !request.nativeSource && !request.record && !request.anchor) {",
    to: "if (kind === 'latest' && !prior && !request.nativeSource && !request.record && !request.anchor) {" },
  'retain-recovered-source-error': { owner: 'packages/client-ui/src/lib/use-conversation-view.ts',
    from: 'failures.delete(conversationSourceKey(observation.source))', to: '' }
}
const selected = process.env.AGENTMUX_TRANSIENT_READING_MUTATION ?? ''
if (selected && !Object.hasOwn(mutations, selected)) throw new Error('Unknown transient reading mutation: ' + selected)

export default defineConfig({ ...base, root, cacheDir: resolve(root, '.cache/conversation-transient-reading-' + (selected || 'positive')),
  plugins: [...base.plugins ?? [], { name: 'original-transient-reading-inputs', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    const path = relative(root, actual), mutation = selected ? mutations[selected] : undefined
    const query = id.includes('?') ? id.slice(id.indexOf('?')) : ''
    const kind = !query && /\.(?:[cm]?[jt]sx?)$/u.test(path) ? 'module' : 'resource'
    const applied = kind === 'module' && mutation?.owner === path
    let loaded = source
    if (mutation && applied) {
      if (source.split(mutation.from).length !== 2) throw new Error('Transient mutation requires one exact original owner site: ' + selected)
      loaded = source.replace(mutation.from, mutation.to)
    }
    if (process.env.AGENTMUX_TRANSIENT_READING_LOADED) {
      const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_TRANSIENT_READING_LOADED, JSON.stringify({ path, kind, query, fileSHA256: sha(readFileSync(actual)),
        originalSHA256: sha(source), loadedSHA256: sha(loaded), mutation: applied ? selected : null }) + '\n')
    }
    return applied ? loaded : undefined
  } }],
  test: { ...base.test, include: ['packages/core/test/conversation-native-source-integrity.test.ts',
    'packages/core/test/conversation-transient-public-reading.test.ts',
    'apps/desktop/test/transient-history-source-recovery.integration.test.tsx'],
    fileParallelism: false, maxWorkers: 1, passWithNoTests: false } })
