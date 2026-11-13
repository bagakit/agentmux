import original from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..')
export default { ...original, cacheDir: '.cache/mote-reading-continuity',
 plugins: [...original.plugins ?? [], { name: 'actual-mote-reading-owner', enforce: 'pre' as const, transform(source: string, id: string) {
  const file = id.split('?')[0], mutation = process.env.AGENTMUX_MOTE_READING_MUTATION, trace = process.env.AGENTMUX_MOTE_READING_EXECUTED
  const relative = file.slice(root.length + 1)
  const targets = ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'apps/desktop/src/renderer/src/components/MoteActivityConversation.tsx', 'packages/client-ui/src/components/MoteConversationThreads.tsx']
  if (!targets.includes(relative)) return
  let code = source
  if (mutation) {
   const changes: Record<string, [string, string, string]> = {
    'eager-empty-host': [targets[0]!, '  if (!presented.current) return null\n  return <StableWorkbenchView homeId={`${target.hostId}:parked`}', '  void presented.current /* Mutant: eager unpresented secondary host */\n  return <StableWorkbenchView homeId={`${target.hostId}:parked`}'],
    'active-only': [targets[0]!, '  if (target.visible !== false) presented.current = true', '  if (target.active && target.visible !== false) presented.current = true'],
    'raw-current-slot': [targets[1]!, '  return <MoteConversationThreads enabled={context !== null}', '  if (!context) return renderCurrent([])\n  return <MoteConversationThreads enabled={context !== null}'],
    'foreign-page': [targets[1]!, '(!view.page || sameMotePreferencesTarget(target, view.page.main.target))', 'true /* Mutant: foreign page accepted */'],
    'stale-qualified-view': [targets[1]!, '[visible, context?.view.key, context?.view.refresh, sourceRevision, memberIntent, executionHostId, sessionId]', '[visible, Boolean(context), sourceRevision, memberIntent]'],
    'current-only-actor': [targets[1]!, '(!view.page || sameMotePreferencesTarget(target, view.page.main.target))', '(!view.page || sameMotePreferencesTarget(target, view.page.main.target) && view.page.main.current?.hostId === executionHostId && view.page.main.current.sessionId === sessionId)'],
    'actor-current': [targets[2]!, 'sameActor(actor, { hostId: main.hostId, agentSessionId: main.sessionId })', 'true /* Mutant: actor given Current-only control */']
   }
   const change = changes[mutation]
   if (!change) throw Error('Unknown actual Mote reading mutation: ' + mutation)
   if (relative === change[0]) {
    if (source.split(change[1]).length !== 2) throw Error('Nonunique actual Mote mutation: ' + mutation)
    code = source.replace(change[1], change[2])
   }
  }
  const row = { path: relative, originalSHA256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), mutation: code !== source ? mutation : null }
  if (process.env.AGENTMUX_MOTE_READING_LOADED) appendFileSync(process.env.AGENTMUX_MOTE_READING_LOADED, JSON.stringify(row)+'\n')
  if (trace) code += `\nimport { appendFileSync as __moteExecuted } from 'node:fs';__moteExecuted(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify(row)+'\n')});\n`
  return code === source ? undefined : { code, map: null }
 }}],
 test: { ...original.test, include: ['apps/desktop/test/mote-reading-continuity.test.tsx', 'apps/desktop/test/mote-threads-source.test.tsx'], testTimeout: 20000 } }
