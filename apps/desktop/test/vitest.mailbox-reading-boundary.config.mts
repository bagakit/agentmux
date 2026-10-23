import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mailbox-original-reveal.config.mts'
import { candidateModule } from '../scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
const pane = 'apps/desktop/src/renderer/src/components/SessionPane.tsx'
const activity = 'apps/desktop/src/renderer/src/components/ActivityView.tsx'
const selected = process.env.AGENTMUX_READING_BOUNDARY_MUTATION ?? ''
const originals = selected === 'original-production-source'
const mutations: Record<string, { owner: string; edits: readonly (readonly [string, string])[] }> = {
  'pollute-summary-record': { owner: pane, edits: [
    ['{ enabled: activityDemand }', '{ enabled: activityDemand || Boolean(revealRequest) }'],
    ['    nativeContextItems\n  } = useSessionUserMessages(', '    nativeContextItems, conversation: inputSummary\n  } = useSessionUserMessages('],
    ['  const revealConversationItem = useCallback(', '  useEffect(() => {\n    if (revealRequest) void inputSummary.selectRecord(revealRequest.record, { signal: revealRequest.signal })\n  }, [revealRequest, inputSummary.selectRecord])\n  const revealConversationItem = useCallback(']
  ] },
  'aggregate-error-blocks-healthy-target': { owner: activity, edits: [
    ['if (reading.error && !acceptedTargetAvailable(reading))', 'if (reading.error)']
  ] },
  'reread-loaded-record': { owner: activity, edits: [
    ['revealReadGeneration.current !== revealRequest.generation && !loaded', 'revealReadGeneration.current !== revealRequest.generation && true']
  ] }
}
if (selected && !originals && !mutations[selected]) throw new Error('Unknown reading boundary mutation: ' + selected)
const baseline = originals ? JSON.parse(readFileSync(resolve(root, process.env.AGENTMUX_READING_BOUNDARY_BASELINE ?? ''), 'utf8')) : null
if (originals && (!Array.isArray(baseline.owners) || baseline.owners.length !== 6 ||
    !Array.isArray(baseline.historicalDependencies) || baseline.historicalDependencies.length !== 2)) throw new Error('Missing exact original production owner/dependency set')
const cases = [
  'old-record navigation and Current keep the original summary receiving later inputs and answer context',
  'an Inputs record read from the original older Provider pages locates its exact record beyond the Pane recent window through local',
  'an accepted complete native target remains locatable when only captured changes are unavailable',
  ...[false, true].map(detail => `real Inputs native action (detail=${detail}) selects complete provider/session/record namespace with stable projection and handoff`)
]
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
export default defineConfig({ ...base, root, cacheDir: resolve(root, '.cache/mailbox-reading-boundary-' + (selected || 'positive')),
  plugins: [...base.plugins ?? [], { name: 'mailbox-reading-boundary-owner', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    const path = relative(root, actual), query = id.includes('?') ? id.slice(id.indexOf('?')) : ''
    const kind = !query && /\.(?:[cm]?[jt]sx?)$/u.test(path) ? 'module' : 'resource'
    let loaded = source, changes = 0, applied: string | null = null
    const old = kind === 'module' && baseline && [...baseline.owners, ...baseline.historicalDependencies].find((entry: { path: string }) => entry.path === path)
    const selection = mutations[selected]
    if (old) {
      loaded = readFileSync(resolve(root, old.snapshot), 'utf8')
      if (createHash('sha256').update(loaded).digest('hex') !== old.sha256) throw new Error('Original production owner snapshot changed: ' + path)
      applied = selected; changes = 1
    } else if (kind === 'module' && selection?.owner === path) {
      for (const [from, to] of selection.edits) {
        if (loaded.split(from).length !== 2) throw new Error('Missing exact reading boundary mutation: ' + selected)
        loaded = loaded.replace(from, to); changes++
      }
      applied = selected
    }
    if (process.env.AGENTMUX_READING_BOUNDARY_LOADED) {
      const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_READING_BOUNDARY_LOADED, JSON.stringify({ path, kind, query,
        fileSHA256: sha(readFileSync(actual)), originalSHA256: sha(source), loadedSHA256: sha(loaded), mutation: applied, changes }) + '\n')
    }
    return loaded === source ? undefined : { code: loaded, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/mailbox-message-navigation.integration.test.tsx',
    'apps/desktop/test/mailbox-older-record-navigation.integration.test.tsx'],
    testNamePattern: new RegExp('^(?:' + cases.map(escape).join('|') + ')$'),
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
