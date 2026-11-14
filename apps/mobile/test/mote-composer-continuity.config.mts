import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './mote-conversation-start.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mobile = 'apps/mobile/src/'
const mutations: Record<string, { file: string; edits: [string, string][]; test: string }> = {
  'remount-editor': { file: mobile + 'conversation/mote-composer.tsx',
    edits: [['<ComposerHost ownerKey={ownerKey}', '<ComposerHost key={selectedSource} ownerKey={ownerKey}']], test: 'keeps one editor' },
  'cross-owner-editor': { file: 'packages/client-ui/src/components/ComposerHost.tsx',
    edits: [['<AgentComposer key={surface.ownerKey}', '<AgentComposer']], test: 'isolates editor undo and IME' },
  'rekey-runtime': { file: mobile + 'conversation/mote-composer.tsx',
    edits: [['}, [address])', '}, [address, client?.runtimeOwnerIdentity?.()?.runtimeId])']], test: 'half draft when its runtime source changes' },
  'lost-text-address': { file: mobile + 'conversation/local-drafts.ts',
    edits: [['...(moteTextSources.size ? { moteTextSources: [...moteTextSources] } : {}),', '...{},']], test: 'restores first-frame text' },
  'wrong-text-source': { file: mobile + 'conversation/MobileConversationSurface.tsx',
    edits: [['textDraft: composer?.text', 'textDraft: undefined']], test: 'sends its own text' },
  'wrong-attempt-key': { file: mobile + 'conversation/use-mobile-prompt-controller.ts',
    edits: [["const draftKey = JSON.stringify(['draft', agentSessionId])", "const draftKey = textDraft?.key ?? JSON.stringify(['draft', agentSessionId])"]], test: 'sends its own text' },
  'lost-text-custody': { file: mobile + 'conversation/local-drafts.ts',
    edits: [['...(intent.textSource ? { textSource: structuredClone(intent.textSource) } : {}),', '...{},']], test: 'sends its own text' },
  'stale-source-actions': { file: mobile + 'conversation/mote-composer.tsx',
    edits: [['current.current.sourceKey === key && text.isCurrent()', 'current.current.sourceKey === key'],
      ["const selectedSource = enabled && text.isCurrent() ? sourceKey : 'unconfirmed-original-device'", 'const selectedSource = sourceKey']], test: 'half draft when its runtime source changes' },
  'lost-receipt-observation': { file: mobile + 'navigation/MobileMoteMainActions.tsx',
    edits: [["if (event.type === 'agent-input' && inputKeys.some", "if (false && event.type === 'agent-input' && inputKeys.some"]], test: 'original early input receipt' },
  'lost-text-target': { file: mobile + 'conversation/use-mobile-prompt-controller.ts',
    edits: [["if (!originalBody && isTextTargetCurrent && !isTextTargetCurrent())", "if (false && !originalBody && isTextTargetCurrent && !isTextTargetCurrent())"]], test: 'undispatched input' },
  'main-manual-bypass': { file: mobile + 'conversation/use-mobile-prompt-controller.ts',
    edits: [[": explicit && originalMain ? { kind: 'session-conversation' as const } : undefined", ': undefined']], test: 'new B on session-conversation' },
  'draft-aba': { file: mobile + 'conversation/use-mobile-prompt-controller.ts',
    edits: [['if (!producer || draftEdits.current !== producer.revision) return', 'if (!producer) return']], test: 'after A to B to A' },
  'lost-attachment-owner': { file: mobile + 'conversation/MobileConversationSurface.tsx',
    edits: [['<MobileAttachments owner={attachmentOwner}', '<MobileAttachments']], test: 'original selected attachment bytes' }
}
const mutation = process.env.AGENTMUX_MOBILE_COMPOSER_MUTATION, selected = mutation ? mutations[mutation] : null
if (mutation && !selected) throw Error('Unknown Mobile Composer source mutation: ' + mutation)
const trace = process.env.AGENTMUX_MOBILE_COMPOSER_TRACE
const owners = new Set([
  ...Object.values(mutations).map(item => item.file), mobile + 'MobileApp.tsx', mobile + 'navigation/MobileMoteConversationStart.tsx',
  mobile + 'conversation/mote-main-input.ts', mobile + 'recovery/device-workface.ts', 'packages/client-ui/src/components/ComposerHost.tsx',
  mobile + 'conversation/MobileAttachments.tsx', mobile + 'mobile-web/update-safety.ts',
  'packages/client-ui/src/components/AgentComposer.tsx'
])
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export default { ...base, plugins: [...base.plugins ?? [], { name: 'actual-mobile-composer-source', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (id.includes('?') || !owners.has(path)) return
    let loaded = source
    if (selected?.file === path) for (const [before, after] of selected.edits) {
      if (loaded.split(before).length !== 2) throw Error('Mobile Composer mutation must match exactly once: ' + mutation)
      loaded = loaded.replace(before, after)
    }
    const fact = { path, mutation: selected?.file === path ? mutation : null, fileSHA256: sha(readFileSync(id)), originalSHA256: sha(source), loadedSHA256: sha(loaded) }
    if (trace) appendFileSync(trace, JSON.stringify({ ...fact, stage: 'loaded' }) + '\n')
    return { code: loaded + (trace ? '\nimport { appendFileSync as __mobileComposerEvidence } from "node:fs";\n' +
      '__mobileComposerEvidence(' + JSON.stringify(resolve(trace)) + ', ' + JSON.stringify(JSON.stringify({ ...fact, stage: 'evaluated' }) + '\n') + ');\n' : ''), map: null }
  }
}], test: { ...base.test, ...(selected ? { testNamePattern: selected.test } : {}), passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } }
