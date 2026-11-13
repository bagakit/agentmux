import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import base from '../../vitest.mote-context.config.mts'

// Loaded mutants for the Desktop surface of a Session Core holds no native conversation for.
// verify-empty-native-surface.mjs requires the candidate to pass and each mutant to fail its case.
const root = resolve(import.meta.dirname, '../../../../..')
const pane = 'apps/desktop/src/renderer/src/components/SessionPane.tsx'
const actions = 'apps/desktop/src/renderer/src/components/SessionRecoveryActions.tsx'
const helper = 'apps/desktop/src/renderer/src/lib/session-recovery-actions.ts'
const spatial = 'apps/desktop/src/renderer/src/lib/space-agent-control.ts'
const notice = 'apps/desktop/src/renderer/src/lib/continuity-failure-notice.ts'
const submit = 'apps/desktop/src/renderer/src/lib/composer-submit-mode.ts'
export const mutations: Record<string, Array<[string, string, string]>> = {
  // The reason maps back to the identity class: a doomed re-read instead of the working action.
  'reason-as-refresh': [[notice, "        remedy: { kind: 'start-new' },\n        actionLabel: 'Start a new conversation here'", "        remedy: { kind: 'refresh' },\n        actionLabel: 'Start a new conversation here'"]],
  // The primary action starts a conversation that sends the original draft or a prompt.
  'start-sends-prompt': [[helper, "    content: { kind: 'new-agent', executorId }\n", "    content: { kind: 'new-agent', executorId, prompt: 'Continue the original task.' }\n"]],
  // Moving the workface must not change the original execution Host or cwd.
  'display-is-execution': [[helper, '    destination: { zoneId: zone.zoneId, displayWorkspaceId: location.displayWorkspaceId,',
    '    destination: { zoneId: location.zoneId, displayWorkspaceId: location.displayWorkspaceId,']],
  // The original remote Host can own an Executor absent from local templates.
  'local-executor-required': [[helper, "  const session = state.sessions.find(item => item.id === source.agentSessionId)\n  if (session?.kind !== 'agent' || session.executorId !== executorId)",
    "  if (!state.config?.executors[executorId]) throw new Error('Executor not in local templates')\n  const session = state.sessions.find(item => item.id === source.agentSessionId)\n  if (session?.kind !== 'agent' || session.executorId !== executorId)"]],
  'execution-change-ignored': [[helper, '  }, undefined, { besideTabId: source.tabId, authorize: ownsExecution, recovery: {',
    '  }, undefined, { besideTabId: source.tabId, authorize: () => current() && ownsRecoverySource(source), recovery: {']],
  // The new Tab is appended at the end of the Group instead of beside the original.
  'tab-not-beside': [[spatial, '    const placement = applySpatialPlacement(ports.get(), topics, target, surface, from, options?.besideTabId)', '    const placement = applySpatialPlacement(ports.get(), topics, target, surface, from)']],
  // A remount mints a fresh operation and creates a second conversation.
  'remount-mints-fresh': [[helper, "  const requestId = await recoveryOperationId(source, 'start-new')\n  assertSource(source, current)\n  const original = await inspectRecoveryRequest(source, 'start-new')\n  if (original) return original\n",
    "  const requestId = 'start-new:' + crypto.randomUUID()\n  assertSource(source, current)\n"]],
  // The surface keeps the restore button next to the new action.
  'restore-kept': [[actions, '    {startNew ? <StartNewConversation source={source} executorId={startNew.executorId} /> : hideRestore ? null : <button',
    '    {startNew ? <StartNewConversation source={source} executorId={startNew.executorId} /> : null}{hideRestore ? null : <button']],
  // The neutral fact is shown as a failure.
  'shown-as-failure': [[pane, "  const restoreFailed = !startNew && (continuityNotice ||", "  const restoreFailed = (continuityNotice ||"]],
  // Enter still drives the recovery Core has refused.
  'enter-recovers': [[submit, "      return { canType: true, canSubmit: false, primaryAction: 'send', placeholder: 'Your draft is kept. Start a new conversation above to continue.' }",
    "      return { canType: true, canSubmit: true, primaryAction: 'send', placeholder: 'Your draft is kept. Start a new conversation above to continue.' }"]]
}
const owned = new Set(Object.values(mutations).flat().map(([path]) => path))
export default { ...base, plugins: [...((base as { plugins?: unknown[] }).plugins ?? []), {
  name: 'empty-native-surface-mutants', enforce: 'pre' as const, transform(code: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (!owned.has(path)) return
    const original = code, mutation = process.env.AMX_EMPTY_NATIVE_SURFACE_MUTATION
    if (mutation) {
      const edits = mutations[mutation]
      if (!edits) throw new Error('Unknown empty-native surface mutation: ' + mutation)
      for (const [target, anchor, replacement] of edits) if (path === target) {
        if (code.split(anchor).length !== 2) throw new Error('Mutation anchor not unique: ' + mutation)
        code = code.replace(anchor, replacement)
      }
    }
    if (process.env.AMX_EMPTY_NATIVE_SURFACE_LOADED) appendFileSync(process.env.AMX_EMPTY_NATIVE_SURFACE_LOADED,
      JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'),
        sha256: createHash('sha256').update(code).digest('hex'), ...(code !== original ? { mutation } : {}) }) + '\n')
    if (code !== original) return { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/session-recovery-actions.test.tsx', 'apps/desktop/test/continuity-failure-notice.test.ts', 'apps/desktop/test/composer-submit-mode.test.ts'] } }
