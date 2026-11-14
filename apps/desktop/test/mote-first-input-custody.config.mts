import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './mote-conversation-start-public-consumer.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const desktop = 'apps/desktop/src/renderer/src/', mobile = 'apps/mobile/src/navigation/'
const mutations: Record<string, { file: string; from: string; to: string }> = {
  'desktop-lost-text': { file: 'apps/desktop/src/shared/mote-main-action.ts',
    from: '...(readable ? { deferredInput: { operationId: query.operationId, prompt: query.prompt } } : {})', to: '...{}' },
  'desktop-late-custody': { file: desktop + 'lib/mote-main-action.ts',
    from: 'await retainMoteMainCreationReference({ target, operationId,', to: 'await api.spatial.read()\n  await retainMoteMainCreationReference({ target, operationId,' },
  'desktop-inspection-blocked': { file: desktop + 'components/MoteMainActions.tsx',
    from: 'if (inspection.current || !active) return', to: 'if (inspection.current || flight.current || !active) return' },
  'desktop-inspection-retargeted': { file: desktop + 'lib/mote-main-action.ts',
    from: 'target:originals[0]?.target ?? targetOf(scope)', to: 'target:targetOf(scope)' },
  'desktop-clears-later-draft': { file: desktop + 'components/MoteConversationStart.tsx',
    from: 'edits.current !== original.revision || original.lifetime !== lifetime.current || useLauncherState.getState().drafts[key]?.prompt !== original.prompt',
    to: 'original.lifetime !== lifetime.current' },
  'desktop-overwrites-unowned-question': { file: desktop + 'lib/mote-main-action.ts',
    from: 'if (!originalMainCreationRetainsInput(prior, reading.previousCreation)) throw',
    to: 'if (false && !originalMainCreationRetainsInput(prior, reading.previousCreation)) throw' },
  'desktop-transfer-drops-later-question': { file: desktop + 'lib/mote-main-action.ts',
    from: "useLauncherState.getState().drafts[draftKey]?.prompt !== merged || !same(current(), reference)",
    to: '!same(current(), reference)' },
  'mobile-late-custody': { file: mobile + 'MobileMoteMainActions.tsx',
    from: 'await owner.retainAgentCreate(intent, recordId)', to: "await client.forwardRpc('space.state', {})\n          await owner.retainAgentCreate(intent, recordId)" },
  'mobile-inspection-blocked': { file: mobile + 'MobileMoteMainActions.tsx',
    from: 'if (!client?.forwardRpc || !visible || inspection.current) return',
    to: 'if (!client?.forwardRpc || !visible || inspection.current || flight.current) return' },
  'mobile-cold-creation-archives-conflicting-input': { file: mobile + 'MobileMoteMainActions.tsx',
    from: "phase: mainIntentCustodyConfirmed(local, setup) ? 'confirmed' : 'unknown'",
    to: "phase: setup.creation === 'confirmed' ? 'confirmed' : 'unknown'" },
  'mobile-advance-creation-archives-conflicting-input': { file: mobile + 'MobileMoteMainActions.tsx',
    from: "phase: mainIntentCustodyConfirmed(localIntent, value) ? 'confirmed' : 'unknown'",
    to: "phase: value.creation === 'confirmed' ? 'confirmed' : 'unknown'" },
  'mobile-custody-blocks-independent-creation': { file: mobile + 'MobileMoteMainActions.tsx',
    from: '!reading.creationPending.length', to: '!pendingIds.length' },
  'mobile-ignores-original-creation-pending': { file: mobile + 'MobileMoteMainActions.tsx',
    from: '!reading.creationPending.length', to: 'true' },
  'mobile-keeps-stale-creation-ready': { file: mobile + 'MobileMoteMainActions.tsx',
    from: 'setReading(null); refresh(value => value + 1)', to: '/* wrong: old creation eligibility survives the original attempt */' },
  'mobile-clears-later-draft': { file: mobile + 'MobileMoteConversationStart.tsx',
    from: 'owner.recordIdentity() !== original.source.recordId || edits.current !== original.revision || local.drafts.get(key) !== original.raw',
    to: 'owner.recordIdentity() !== original.source.recordId' },
  'duplicate-first-text': { file: 'packages/client-ui/src/components/MoteFirstMessage.tsx',
    from: '{showPrompt ? <ConversationMessage', to: '{true ? <ConversationMessage' }
}
const selected = process.env.AGENTMUX_MOTE_FIRST_MUTATION
if (selected && !Object.hasOwn(mutations, selected)) throw Error('Unknown original first-input mutation: ' + selected)
const owners = new Set(Object.values(mutations).map(mutation => mutation.file))
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export default { ...base, cacheDir: resolve(root, '.tmp/mote-first-input-custody'),
  plugins: [...base.plugins ?? [], { name: 'actual-first-input-custody-source', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (id.includes('?') || !owners.has(file)) return
    const mutation = selected ? mutations[selected] : undefined
    const applies = mutation?.file === file
    let code = source
    if (applies) {
      if (source.split(mutation!.from).length !== 2) throw Error('Original first-input mutation must match once: ' + selected)
      code = source.replace(mutation!.from, mutation!.to)
    }
    const log = process.env.AGENTMUX_MOTE_FIRST_TRACE
    const fact = { file, fileSHA256: sha(readFileSync(id)), originalSHA256: sha(source), loadedSHA256: sha(code), mutation: applies ? selected : null }
    if (log) appendFileSync(log, JSON.stringify({ ...fact, stage: 'loaded' }) + '\n')
    if (!log) return applies ? { code, map: null } : undefined
    return { code: code + '\nimport { appendFileSync as __firstInputAppend } from "node:fs";\n' +
      '__firstInputAppend(' + JSON.stringify(log) + ', ' + JSON.stringify(JSON.stringify({ ...fact, stage: 'evaluated' }) + '\n') + ');\n', map: null }
  } }],
  test: { ...base.test, include: [process.env.AGENTMUX_MOTE_FIRST_SURFACE === 'mobile'
    ? 'apps/mobile/test/mote-conversation-start.test.tsx' : 'apps/desktop/test/mote-conversation-start-public-consumer.test.tsx'],
    name: 'original-first-input-custody', passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
}
