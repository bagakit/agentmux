import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { file: string; from: string; to: string }> = {
  'replace-editor-on-source': { file: 'packages/client-ui/src/components/ComposerHost.tsx',
    from: '<AgentComposer key={surface.ownerKey} {...surface.props} active={surface.active} />',
    to: '<AgentComposer key={surface.ownerKey + surface.props.placeholder} {...surface.props} active={surface.active} />' },
  'share-editor-between-owners': { file: 'packages/client-ui/src/components/ComposerHost.tsx',
    from: '<AgentComposer key={surface.ownerKey} {...surface.props} active={surface.active} />',
    to: '<AgentComposer {...surface.props} active={surface.active} />' },
  'submit-session-shadow': { file: 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
    from: "text: moteDraftKey ? record?.prompt ?? '' : useAppStore.getState().agentComposerDrafts[sessionId] ?? ''",
    to: "text: useAppStore.getState().agentComposerDrafts[sessionId] ?? ''" },
  'portal-source-disconnected': { file: 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
    from: 'connection: moteComposer.connection,', to: 'connection: null,' },
  'queue-retry-appends-twice': { file: 'apps/desktop/src/renderer/src/lib/launcher-state.ts',
    from: 'if (previous) {', to: 'if (false && previous) {' },
  'queue-archives-before-draft-ack': { file: 'apps/desktop/src/renderer/src/store.ts',
    from: 'await checkpointLauncherState()\n    }\n    set(state => {\n      const { entry, session } = readOriginal(state)',
    to: '/* wrong: archive without destination ACK */\n    }\n    set(state => {\n      const { entry, session } = readOriginal(state)' },
  'multi-query-auto-selects-remainder': { file: 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
    from: '!rolloverChoiceRequired.current && rollovers.length === 1', to: 'rollovers.length === 1' },
  'welcome-clears-later-draft': { file: 'apps/desktop/src/renderer/src/components/MoteConversationStart.tsx',
    from: "useLauncherState.getState().drafts[key] !== original.draft || original.lifetime !== lifetime.current || useLauncherState.getState().drafts[key]?.prompt !== original.prompt",
    to: 'original.lifetime !== lifetime.current' },
  'dock-loses-original-context': { file: 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
    from: '{moteComposer ? aboveInput : null}', to: '{null}' },
  'main-query-keeps-manual-intent': { file: 'apps/desktop/src/renderer/src/store.ts',
    from: "{ expectedRun: { ...session.control.run }, admissionIntent: { kind: 'manual-actor' } }",
    to: "{ expectedRun: { ...session.control.run }, admissionIntent: { kind: options?.moteMain ? 'session-conversation' : 'manual-actor' } }" },
  'history-keeps-session-owner': { file: 'apps/desktop/src/renderer/src/store.ts',
    from: "if (moteDraftKey) useLauncherState.getState().setDraft(moteDraftKey, 'prompt', result.value)",
    to: '/* wrong: history still edits the original Session owner */' }
}
const selected = process.env.AGENTMUX_COMPOSER_MUTATION
if (selected && !Object.hasOwn(mutations, selected)) throw Error('Unknown Composer continuity mutant: ' + selected)
const owners = new Set([...Object.values(mutations).map(mutation => mutation.file),
  'packages/client-ui/src/components/AgentComposer.tsx',
  'apps/desktop/src/renderer/src/components/MoteComposer.tsx',
  'apps/desktop/src/renderer/src/components/MoteWorkface.tsx',
  'apps/desktop/src/renderer/src/components/MoteEntryReading.tsx',
  'apps/desktop/src/renderer/src/lib/mote-workface.ts',
  'apps/desktop/src/renderer/src/lib/use-composer-input-history.tsx'
])
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export default { ...base, cacheDir: resolve(root, '.cache/mote-composer-continuity'),
  plugins: [...base.plugins ?? [], { name: 'mote-composer-loaded-owner', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (id.includes('?') || !owners.has(file)) return
    const mutation = selected ? mutations[selected] : undefined, applies = mutation?.file === file
    if (applies && source.split(mutation!.from).length !== 2) throw Error('Composer mutant must match its evaluated owner once: ' + selected)
    const code = applies ? source.replace(mutation!.from, mutation!.to) : source
    const trace = process.env.AGENTMUX_COMPOSER_TRACE
    if (!trace) return applies ? { code, map: null } : undefined
    const fact = { file, fileSHA256: sha(readFileSync(id)), sourceSHA256: sha(source), loadedSHA256: sha(code), mutation: applies ? selected : null }
    appendFileSync(trace, JSON.stringify({ ...fact, stage: 'loaded' }) + '\n')
    return { code: code + '\nimport { appendFileSync as __composerTrace } from "node:fs";\n' +
      '__composerTrace(' + JSON.stringify(trace) + ', ' + JSON.stringify(JSON.stringify({ ...fact, stage: 'evaluated' }) + '\n') + ');\n', map: null }
  } }],
  test: { ...base.test, name: 'mote-composer-continuity', include: [process.env.AGENTMUX_COMPOSER_PUBLIC ? 'apps/desktop/test/mote-conversation-start-public-consumer.test.tsx' : 'apps/desktop/test/mote-composer-continuity.test.tsx'],
    maxWorkers: 1, fileParallelism: false, testTimeout: 30_000, passWithNoTests: false }
}
