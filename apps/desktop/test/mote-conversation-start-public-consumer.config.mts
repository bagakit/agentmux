import { defineConfig } from 'vitest/config'
import { isAbsolute, relative, resolve } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { owner: string; from: string; to: string }> = {
  'welcome-query-dropped': { owner: 'apps/desktop/src/renderer/src/lib/mote-main-action.ts',
    from: '...(query ? { deferredInput: query } : {})', to: '...{}' },
  'welcome-unaccepted-clears-draft': { owner: 'apps/desktop/src/renderer/src/components/MoteConversationStart.tsx',
    from: "query.prompt !== original.prompt || !['admitted', 'terminal-confirmed'].includes(outcome) || !current() ||",
    to: 'query.prompt !== original.prompt || !current() ||' },
  'welcome-late-acceptance-steals-reading': { owner: 'apps/desktop/src/renderer/src/components/MoteConversationStart.tsx',
    from: 'current() && mayNavigate() && fresh &&', to: 'current() && fresh &&' },
  'menu-unconfirmed-hides-recovery': { owner: 'apps/desktop/src/renderer/src/components/MoteMainActions.tsx',
    from: "const queryPending = Boolean(result?.record?.moteMain?.deferredInput && !['admitted','terminal-confirmed','not-applied'].includes(queryOutcome))",
    to: 'const queryPending = false' },
  'rollover-ipc-decision-dropped': { owner: 'apps/desktop/src/shared/session-input-result.ts',
    from: '...(source?.moteMainRollover ? { moteMainRollover: source.moteMainRollover } : {}),', to: '...{},' },
  'rollover-treated-as-send-error': { owner: 'apps/desktop/src/renderer/src/store.ts',
    from: 'if (rollover?.mainRollover?.queryOperationId === operationId && rollover.text === entry.text &&',
    to: 'if (false && rollover?.mainRollover?.queryOperationId === operationId && rollover.text === entry.text &&' },
  'rollover-unconfirmed-archives': { owner: 'apps/desktop/src/renderer/src/components/MoteConversationStart.tsx',
    from: "canonical.prompt !== automatic.query.prompt || !['admitted','terminal-confirmed'].includes(outcome)",
    to: 'canonical.prompt !== automatic.query.prompt' },
  'rollover-foreign-start-archives': { owner: 'apps/desktop/src/renderer/src/components/MoteConversationStart.tsx',
    from: 'result.record?.requestId !== automatic.decision.creationOperationId || JSON.stringify(result.record.moteMain?.rollover) !== JSON.stringify(automatic.decision) ||',
    to: 'false ||' },
  'rollover-not-discovered': { owner: 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
    from: 'visible && rollovers.length === 1 &&', to: 'false && visible && rollovers.length === 1 &&' },
  'rollover-multiple-auto-selects': { owner: 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
    from: 'rollovers.length === 1', to: 'rollovers.length >= 1' },
  'rollover-target-unchecked': { owner: 'apps/desktop/src/renderer/src/components/MoteWorkface.tsx',
    from: 'if (JSON.stringify(rollover.decision.target) !== JSON.stringify(dialogue?.target)) return', to: 'void 0' },
  'closed-history-needs-live-occurrence': { owner: 'apps/desktop/src/renderer/src/components/MoteWorkface.tsx',
    from: 'onOpenOriginal={() => setLocal(previous => ({ ...previous, periodOriginal: true }))}',
    to: 'onOpenOriginal={() => { showThread(currentLocal.period!.reference) }}' },
  'discussion-merges-same-session-periods': { owner: 'packages/client-ui/src/components/MoteConversationThreads.tsx',
    from: "(link.period ? link.period.roleRevision !== page?.main.roleRevision : !sameActor(actor, { hostId: link.reference.hostId, agentSessionId: link.reference.sessionId }))",
    to: '!sameActor(actor, { hostId: link.reference.hostId, agentSessionId: link.reference.sessionId })' },
  'period-upper-dropped': { owner: 'packages/client-ui/src/components/MotePeriodConversation.tsx',
    from: 'checkpoint: current.checkpoint, through,', to: 'checkpoint: current.checkpoint,' },
  'period-wire-assembly-dropped': { owner: 'packages/client-ui/src/components/MotePeriodConversation.tsx',
    from: 'consumeConversationWindowPage(page, assembly)', to: 'consumeConversationWindowPage(page)' },
  'period-source-key-collapsed': { owner: 'packages/client-ui/src/components/MotePeriodConversation.tsx',
    from: 'JSON.stringify([connection.current.revision, props.source.period?.id, props.source.reference, range])',
    to: 'JSON.stringify([connection.current.revision, props.source.reference])' },
  'hidden-period-reads': { owner: 'packages/client-ui/src/components/MotePeriodConversation.tsx',
    from: '<BoundedPeriod key={key} {...props} after={range.after} through={range.through} />',
    to: '<BoundedPeriod key={key} {...props} visible={true} after={range.after} through={range.through} />' }
}
const selected = process.env.AGENTMUX_TEST_ROOT_UI_MUTATION ?? ''
if (selected && !Object.hasOwn(mutations, selected)) throw Error('Unknown Root UI behavior mutant: ' + selected)
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/mote-conversation-start-public-consumer'),
  plugins: [...base.plugins ?? [], { name: 'root-ui-loaded-production', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file) || id.includes('?') || !/\.[cm]?[jt]sx?$/u.test(file)) return
    const path = relative(root, file)
    if (!path.startsWith('packages/core/src/') && !path.startsWith('apps/host/src/') &&
      !path.startsWith('packages/client-ui/src/') && !path.startsWith('apps/desktop/src/')) return
    const mutation = selected ? mutations[selected] : undefined
    let loaded = source
    const applied = mutation?.owner === path
    if (applied) {
      if (source.split(mutation!.from).length !== 2) throw Error('Root UI mutation needs one original executable site: ' + selected)
      loaded = source.replace(mutation!.from, mutation!.to)
    }
    const fact = { path, fileSHA256: sha(readFileSync(file)), originalSHA256: sha(source), loadedSHA256: sha(loaded), mutation: applied ? selected : null }
    const log = process.env.AGENTMUX_TEST_ROOT_UI_LOADED
    if (log) appendFileSync(log, JSON.stringify({ ...fact, stage: 'loaded' }) + '\n')
    if (!log) return applied ? loaded : undefined
    return { code: loaded + '\nimport { appendFileSync as __amxRootUiAppend } from "node:fs";\n' +
      '__amxRootUiAppend(' + JSON.stringify(log) + ', ' + JSON.stringify(JSON.stringify({ ...fact, stage: 'evaluated' }) + '\n') + ');\n', map: null }
  } }],
  test: { ...base.test, environment: 'happy-dom', include: ['apps/desktop/test/mote-conversation-start-public-consumer.test.tsx'],
    fileParallelism: false, maxWorkers: 1, testTimeout: 45_000, passWithNoTests: false } })
