import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import owning from './mote-recent-agent.config.mts'

const repository = resolve(import.meta.dirname, '../../..')
const sourceAliases = owning.resolve?.alias
if (!Array.isArray(sourceAliases)) throw new Error('The original Mote Source aliases are required')
const mutant = process.env.AGENTMUX_MOTE_QUICK_CONSUMER_MUTANT
const changes = {
  'launcher-full-read': ['apps/desktop/src/renderer/src/lib/mote-primary-agent.ts',
    'const saved = await readMoteQuickDefaults(scope, false)', 'const saved = await readMoteQuickDefaults(scope)'],
  'envelope-drops-projection': ['packages/core/src/space-control-parser.ts',
    "'baseline', 'values', 'includeChoices', 'nameSource'", "'baseline', 'values', 'nameSource'"],
  'bridge-drops-projection': ['apps/desktop/src/renderer/src/lib/mote-preferences-control.ts',
    'const { operation, requestId: _requestId, schemaVersion: _schema, ...input } = request',
    'const operation = request.operation; const input = { kind: request.kind, target: request.target }'],
  'launcher-omits-retain': ['apps/desktop/src/renderer/src/lib/mote-primary-agent.ts',
    '}, reference, undefined, retain)', '}, reference)'],
  'dialog-drops-held-pending': ['apps/desktop/src/renderer/src/components/MoteQuickMode.tsx',
    'const pending = requested ? { input: requested, phase } : held',
    'const pending = requested ? { input: requested, phase } : undefined'],
  'background-clears-later-draft': ['apps/desktop/src/renderer/src/lib/mote-primary-agent.ts',
    'confirmed && original.createdDraft === JSON.stringify(draft) ? undefined : draft', 'undefined']
} as const
if (mutant && !(mutant in changes)) throw new Error('Unknown Mote Quick consumer mutant')
const sources: readonly string[] = [...new Set(Object.values(changes).map(([path]) => path))]
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ ...owning,
  cacheDir: resolve(repository, '.local/mote-quick-consumers/cache'),
  // Reuse the original Core fixture's generated-text asset, without a new build.
  resolve: { ...owning.resolve, alias: [{ find: '@agentmux/identity/runtime-source',
    replacement: resolve(repository, 'packages/identity/dist/runtime-source.js') }, ...sourceAliases] },
  plugins: [...owning.plugins ?? [], {
    name: 'mote-quick-consumer-source', enforce: 'pre',
    transform(code, id) {
      const path = relative(repository, id.split('?')[0]!)
      // Original auxiliary-user tests use this same native-document branch with
      // mockApi only as the Electron transport seam, backed by the real file owner.
      if (['apps/desktop/src/renderer/src/lib/launcher-state.ts', 'apps/desktop/src/renderer/src/lib/desktop-user-state.ts'].includes(path)) {
        const loaded = code.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false')
        const trace = process.env.AGENTMUX_MOTE_QUICK_CONSUMER_TRACE
        if (trace) appendFileSync(trace, JSON.stringify({ path, mutant: mutant ?? null, originalSha256: sha(code), loadedSha256: sha(loaded), changed: false, environmentPin: 'original-native-user-document' }) + '\n')
        return { code: loaded, map: null }
      }
      if (!sources.includes(path)) return null
      const original = code
      const change = mutant ? changes[mutant as keyof typeof changes] : undefined
      if (change?.[0] === path) {
        if (code.split(change[1]).length !== 2) throw new Error('Mote Quick mutation requires one exact current Source anchor')
        code = code.replace(change[1], change[2])
      }
      const trace = process.env.AGENTMUX_MOTE_QUICK_CONSUMER_TRACE
      if (trace) appendFileSync(trace, JSON.stringify({ path, mutant: mutant ?? null, originalSha256: sha(original), loadedSha256: sha(code), changed: original !== code }) + '\n')
      return original === code ? null : { code, map: null }
    }
  }],
  test: { ...owning.test,
  include: ['test/mote-recent-agent.test.tsx', 'test/mote-quick-mode.test.tsx', 'test/mote-first-primary.test.tsx', 'test/mote-quick-control-projection.test.tsx'],
  passWithNoTests: false, testTimeout: 15000
} })
