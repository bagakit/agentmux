import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import base from '../../desktop/test/mote-main-policy-settings.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const files = ['apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/navigation/MobileMoteConversationStart.tsx', 'apps/mobile/src/navigation/MobileMoteMainActions.tsx',
  'apps/mobile/src/conversation/MobileConversationSurface.tsx', 'apps/mobile/src/conversation/use-mobile-prompt-controller.ts', 'apps/mobile/src/conversation/mote-main-input.ts', 'apps/mobile/src/navigation/MobileMoteStartPortrait.tsx',
'apps/mobile/src/conversation/MobileMoteSourceNotice.tsx', 'apps/mobile/src/conversation/MobileMoteConversation.tsx']
const mutations: Record<string, { file: string; edits: [string, string][] }> = {
  'welcome-wire': { file: files[0]!, edits: [['welcomeVisible && moteTarget && objectIdentity && !historyVisible &&', 'false && welcomeVisible && moteTarget && objectIdentity && !historyVisible &&']] },
  'first-query': { file: files[2]!, edits: [['deferredInput: { operationId: query.operationId, prompt: query.prompt }', "deferredInput: { operationId: query.operationId, prompt: 'Wrong original question' }"]] },
  'binding-only': { file: files[1]!, edits: [["(outcome !== 'admitted' && outcome !== 'terminal-confirmed') || ", '']] },
  'late-draft': { file: files[1]!, edits: [['edits.current === original.revision', 'true'], ["if (!current() || local.drafts.get(original.source.key) !== original.raw) return", 'if (!current()) return']] },
  'mote-scope': { file: files[1]!, edits: [['target.spaceId, target.zoneId,', '/* omitted original Mote/Zone */']] },
  'inspect-advance': { file: files[2]!, edits: [["await client.forwardRpc!('space.mote.dialogue.setup.inspect', input)", "await client.forwardRpc!('space.mote.dialogue.setup.advance', input)"]] },
  'handover': { file: files[2]!, edits: [["...(baseline.defaults.conversation ? { handover: true as const } : {})", '...({})']] },
  'history-period': { file: files[1]!, edits: [["source.period?.id ?? JSON.stringify(['legacy-main', source.roleRevision, source.operationId])", 'JSON.stringify([source.reference.hostId, source.reference.sessionId])']] },
  'unknown-reader': { file: files[0]!, edits: [["if ((!facts || facts.quickMode.status === 'unconfirmed') && objectIdentity", "if (false && (!facts || facts.quickMode.status === 'unconfirmed') && objectIdentity"]] },
  'due-wire': { file: files[4]!, edits: [["if (result.disposition === 'rollover-required' && result.rollover?.status === 'due' && result.rollover.decision)", "if (false && result.disposition === 'rollover-required' && result.rollover?.status === 'due' && result.rollover.decision)"]] },
  'late-due': { file: files[4]!, edits: [["producer && draftEdits.current === producer.revision && drafts.current.get(producer.key) === original.draft && mounted.current", 'producer && mounted.current']] },
  'archive': { file: files[4]!, edits: [['attempts.current.delete(producer.key)', '/* stale active attempt retained */']] },
  'source-reason': { file: files[7]!, edits: [['{configurationIssue && <><dt>配置</dt><dd>{configurationIssue}</dd></>}', '{false && <><dt>配置</dt><dd>{configurationIssue}</dd></>}']] },
  'period-wire': { file: files[0]!, edits: [['source={moteHistory} client={client}', 'source={{ ...moteHistory, period: undefined }} client={client}']] }
}
export default { ...base, cacheDir: resolve(root, '.tmp/mobile-mote-start-vitest'),
  plugins: [...base.plugins ?? [], { name: 'loaded-mobile-mote-start', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = id.replace(root + '/', ''), trace = process.env.AGENTMUX_MOTE_START_TRACE, name = process.env.AGENTMUX_MOTE_START_MUTATION
    if (!trace || !files.includes(file)) return
    const mutation = name ? mutations[name] : null
    if (name && !mutation) throw Error('Unknown Mobile start mutation: ' + name)
    if (mutation && file !== mutation.file) return
    let code = source
    for (const [before, after] of mutation?.edits ?? []) {
      if (code.split(before).length !== 2) throw Error('Mobile start mutation anchor must match once: ' + name)
      code = code.replace(before, after)
    }
    const marker = { file, mutation: name ?? null, sourceHash: createHash('sha256').update(source).digest('hex'), loadedHash: createHash('sha256').update(code).digest('hex') }
    appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...marker }) + '\n')
    return code + `\nimport { appendFileSync as __mobileStartEvidence } from 'node:fs'; __mobileStartEvidence(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({ phase: 'evaluated', ...marker }) + '\n')});\n`
  } }],
  resolve: { ...base.resolve, alias: [
    { find: /^@agentmux\/client-ui\/styles\/(.*)$/, replacement: resolve(root, 'packages/client-ui/src/styles/$1') },
    { find: /^@agentmux\/client-ui\/agent-icons\/(.*)$/, replacement: resolve(root, 'packages/client-ui/src/assets/agent-icons/$1') },
    ...base.resolve!.alias as import('vite').Alias[]
  ] },
  test: { ...base.test, include: ['apps/mobile/test/mote-conversation-start.test.tsx'], testTimeout: 30000 }
}
