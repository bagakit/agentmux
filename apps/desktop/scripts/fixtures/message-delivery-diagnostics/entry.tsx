import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { flushSync } from 'react-dom'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { messageDeliveryDiagnostics } from '../../../src/renderer/src/lib/message-delivery-diagnostics'
import { startDeliveryAttempt } from '@agentmux/client-ui/delivery-diagnostics'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { AgentInputSubmissionReceipt } from '@agentmux/core'

const config = api.config.get, snapshot = api.sessions.snapshot
api.config.get = async () => {
  const original = await config()
  return { ...original, workspaces: original.workspaces.map(workspace => ({ ...workspace,
    path: workspace.path.startsWith('/') ? workspace.path : (_hygiene_fixturePath("preview/") + (workspace.path) + "") })) }
}
api.sessions.snapshot = async () => {
  const original = await snapshot()
  return { ...original, sessions: original.sessions.map(session => ({ ...session,
    workspacePath: session.workspacePath.startsWith('/') ? session.workspacePath : (_hygiene_fixturePath("preview/") + (session.workspacePath) + "") })) }
}
const attach = api.sessions.attach
api.sessions.attach = async (...args) => {
  const snapshot = await attach(...args)
  return { ...snapshot, terminal: snapshot.terminal.type !== 'basic-vt' ? snapshot.terminal : {
    ...snapshot.terminal, restoreBytes: new TextEncoder().encode('\x1b[0m'), checkpoint: {
      ...snapshot.terminal.checkpoint, restoreSize: snapshot.terminal.checkpoint.size,
      restoreScrollbackRows: 0, resizeAfterRestoreBytes: 0
    }
  } }
}
await import('../agent-region-actions/entry')
mountThemeRuntime(window, useAppStore.getState().config?.appearance ?? {})
const base = (window as any).regionActions
const copies: string[] = []
let copyFails = false
api.ui.writeClipboardText = async text => { if (copyFails) throw new Error('Private clipboard refused'); copies.push(text) }
api.continuousProgress.list = async () => []
// The fixture supplies existing Store/API facts; it never owns admission or sends to a user Run.
const probe = {
  async seed(kind: 'preparation' | 'unknown' | 'legacy' | 'compaction' | 'first-wait' | 'exhausted' | 'observer', appearance: 'dark' | 'light') {
    const generation = base.mode('terminal')
    updateThemeSelection({ ...useAppStore.getState().config?.appearance, appAppearance: appearance })
    const session = useAppStore.getState().sessions[0]!
    const operationId = `private-message-${kind}`
    const condition = { expectedRun: session.control.run, afterSubmissionId: null }
    const reason = kind === 'compaction' || kind === 'first-wait' || kind === 'exhausted' ? 'context-compaction' : undefined
    const raw = 'This call ended during read-only preparation before attempting input. [AGENT_PROMPT_PREPARATION_FAILED] {"code":"AGENT_INPUT_PREPARATION_UNCONFIRMED","detail":"{\\"preclaimObservation\\":{\\"phase\\":\\"current-pane\\",\\"predicateEvaluations\\":294}}"}'
    const error = Object.assign(new Error(kind === 'legacy' ? raw.replace('AGENT_PROMPT_PREPARATION_FAILED', 'LEGACY_FAILURE') : raw), {
      code: kind === 'legacy' ? 'LEGACY_FAILURE' : 'AGENT_PROMPT_PREPARATION_FAILED',
      detail: JSON.stringify(reason ? { preparationWait: { reason, retrySafe: true, agentSessionId: session.id,
        runId: session.control.run.runId, operationId, inputByte: 0, nativeSourceId: 'private-native-source' } } : { preclaimObservation: { phase: 'current-pane', predicateEvaluations: 294 } }),
      ...(kind !== 'legacy' ? { controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } } : {})
    })
    const key = { kind: 'prompt' as const, agentSessionId: session.id, expectedRun: { ...session.control.run }, submissionId: operationId }
    const ref = { key, waitGeneration: 1 }
    const inputReceipt: AgentInputSubmissionReceipt | undefined = kind === 'observer' ? {
      key, ref, persistence: 'confirmed', status: 'waiting', admission: null, observation: 'rejoin-needed',
      control: { ref, state: 'enabled', at: Date.now(), waiting: { phase: 'observer', reason: 'observer-stopped', wake: 'explicit-rejoin',
        failure: { name: 'AbortError', message: 'This operation was aborted' }, observation: { phase: 'native-peer' } } }
    } : undefined
    const seed = startDeliveryAttempt({ agentSessionId: session.id, operationId, hostId: session.hostId, condition, execution: 'immediate' })
    const diagnostic = kind === 'first-wait' ? undefined : await messageDeliveryDiagnostics.failed(seed, error, 'core-submit', 'private-original-host')
    copies.length = 0; copyFails = false
    flushSync(() => useAppStore.setState(state => ({
      agentNames: { [session.id]: '实现与优化', [state.sessions[1]!.id]: '设计评审' },
      agentComposerDrafts: { [session.id]: '保留这条草稿，继续检查回复逻辑', [state.sessions[1]!.id]: '邻侧草稿保持可用' },
      agentSteerQueues: { [session.id]: [{ operationId, runId: session.control.run.runId,
        text: '检查主对话的 Session 恢复逻辑，应用启动时自动恢复原对话。', status: 'deferred',
        promptCondition: kind === 'unknown' || kind === 'legacy' ? condition : null,
        ...(diagnostic ? { error: error.message, errorCode: error.code, logId: diagnostic.record.logId } : {}), enqueuedAt: Date.now(),
        ...(inputReceipt ? { inputReceipt } : {}),
        ...(reason ? { preparationInputNotApplied: true, preparationWait: { reason, state: kind === 'exhausted' ? 'exhausted' : 'waiting',
          attempt: kind === 'exhausted' ? 3 : 2, maxAttempts: 3, nextAttemptAt: kind === 'exhausted' ? null : Date.now() + 4_000 } } : {}) }] }
    })))
    return { generation, operationId, logId: seed.logId, report: diagnostic, inputReceipt }
  },
  copyFails(value: boolean) { copyFails = value },
  facts() { const state = useAppStore.getState(); return { copies: [...copies], drafts: state.agentComposerDrafts,
    sessions: state.sessions.map(session => ({ id: session.id, control: session.control })),
    queues: state.agentSteerQueues, base: base.facts() } }
}
Object.assign(window, { deliveryDiagnostics: probe })
