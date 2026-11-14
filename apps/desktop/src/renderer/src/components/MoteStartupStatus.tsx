import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAgentInputMailbox } from '@agentmux/client-ui/use-agent-input-mailbox'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { MoteDefaultConversation } from '@agentmux/core/mote-preferences'
import { Button } from '@agentmux/client-ui/components/Button'
import { agentSessionPresentationIndex } from '../lib/session-presentation'
import { sessionFrontendPresentation } from '../lib/session-recovery-banner'
import { originalFrontendRecovery } from '../lib/session-original-recovery'
import { useAppStore } from '../store'
import { api } from '../lib/api'
import { OriginalInputWaitingControl } from './OriginalInputWaitingControl'
import { useObservedAppStore } from '../lib/use-observed-app-store'

/** Original Session/Run setup facts, next to the conversation they belong to. */
export function MoteStartupStatus({ reference, active, onOpenTerminal }: {
  reference: MoteDefaultConversation; active: boolean; onOpenTerminal(sessionId: string): void
}) {
  const displayId = useAppStore(state => { const region = state.tabs[reference.tabId]?.regions[reference.regionId]; return region?.kind === 'agent' ? region.sessionId : undefined })
  const consumer = useMemo(() => ({ sessionIds: [...new Set([reference.sessionId, ...(displayId ? [displayId] : [])])], navigation: false }), [reference.sessionId, displayId])
  const session = useObservedAppStore('workbenchTab', active, consumer, state => {
    const matches = (agentSessionPresentationIndex(state.sessions).get(reference.sessionId) ?? []).filter(item => item.control.hostId === reference.hostId)
    return matches.length === 1 ? matches[0] : undefined
  })
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null)
  const operation = useRef<{ scope: string; operationId: string } | null>(null)
  const read = useCallback<Parameters<typeof useAgentInputMailbox>[0]['read']>(input => api.sessions.inputMailbox({ hostId: reference.hostId, agentSessionId: reference.sessionId }, input), [reference.hostId, reference.sessionId])
  const mailbox = useAgentInputMailbox({ hostId: reference.hostId, agentSessionId: reference.sessionId, enabled: active && Boolean(session), read })
  useEffect(() => {
    if (!active) return
    return api.sessions.onEvent(event => {
      const value = event.event
      if (event.hostId === reference.hostId && value.type === 'agent-input' && value.receipt.key.agentSessionId === reference.sessionId) void mailbox.refresh()
    })
  }, [reference.hostId, reference.sessionId, active, mailbox.refresh])
  if (!active || !session) return null
  const runId = session.control.run.runId
  const frontend = sessionFrontendPresentation(session)
  const continuity = session.continuity?.agentSessionId === session.control.agentSessionId && session.continuity.newRun?.runId === runId && session.continuity.workspaceTrust ? session.continuity
    : Object.values(session.continuityOperations ?? {}).find(operation => operation.agentSessionId === session.control.agentSessionId && operation.newRun?.runId === runId && operation.workspaceTrust)
  const trust = continuity?.workspaceTrust ?? (session.creation?.createdRun?.runId === runId ? session.creation.workspaceTrust : undefined)
  const nativeReady = session.terminalFrontend?.run.runId === runId && session.terminalFrontend.initialization?.phase === 'ready'
  const nativeRequest = session.pendingInteraction?.agentSessionId === session.control.agentSessionId && (!session.pendingInteraction.evidence.run || session.pendingInteraction.evidence.run.runId === runId)
  const nativeAccepted = mailbox.items.some(item => item.kind === 'controlled' && item.receipt?.status === 'admitted' &&
    (item.receipt.control.deliveryKey ?? item.receipt.key).expectedRun.runId === runId)
  const trustIssue = trust?.status === 'unconfirmed' && !nativeReady && !nativeRequest && !nativeAccepted ? trust : undefined
  const starting = mailbox.items.flatMap(item => item.kind === 'controlled' && item.receipt?.status === 'waiting' && item.receipt.control.waiting?.reason === 'native-session-starting' &&
    (item.receipt.control.deliveryKey ?? item.receipt.key).expectedRun.runId === runId ? [item.receipt] : [])[0]
  if (!frontend && !trustIssue && !starting) return null
  const identity = JSON.stringify([session.control.hostId, session.control.agentSessionId, runId])
  async function check() {
    if (busy || !session) return
    setBusy(true); setIssue(null)
    try {
      // A Provider bootstrap has an original reconciliation operation; a failed trust-file
      // observation only needs a fresh Session read and never authorizes a restart.
      if ((frontend?.kind === 'initialization' || frontend?.kind === 'detached') && session.terminalFrontend?.initialization) {
        const scope = identity + ':' + session.terminalFrontend.frontendId
        if (operation.current?.scope !== scope) operation.current = { scope, operationId: originalFrontendRecovery(session)?.operationId ?? crypto.randomUUID() }
        await useAppStore.getState().recoverSession(session.id, operation.current.operationId, { preserveView: true, stillCurrent: () => {
          const value = useAppStore.getState().sessions.find(value => value.id === session.id)
          return value?.control.kind === 'agent' && value.control.hostId === session.control.hostId && value.control.run.runId === runId
        } })
      } else await useAppStore.getState().refreshSession(session.id)
      await mailbox.refresh()
    } catch (cause) { setIssue(presentError(cause)) }
    finally { setBusy(false) }
  }
  return <section className="mote-startup-status" aria-label="Mote startup" aria-busy={busy || undefined} data-startup-session={session.control.agentSessionId} data-startup-run={runId}>
    <div className="mote-startup-status__summary" role="status"><strong>{frontend?.title ?? (starting ? '启动状态待确认，原消息已保存' : '启动准备需要核对')}</strong>
      <p>{frontend?.description ?? (starting ? '原消息正在等待 Agent 完成原生启动，尚未投递。核对进度后会沿原输入继续。' : '目录信任的准备结果尚未确认。Agent 的原身份和输入记录保留。')}</p>
      {frontend?.detail ? <p>{frontend.detail}</p> : null}
    </div>
    <div className="mote-startup-status__actions"><Button type="button" disabled={busy} onClick={() => void check()}>{busy ? '正在核对…' : frontend?.actionLabel ?? '重新核对启动'}</Button>
      <details><summary>启动详情与其他方式</summary>
        {trustIssue ? <p>{trustIssue.issue ?? trustIssue.code}</p> : null}{frontend?.diagnostic ? <p>{frontend.diagnostic}</p> : null}
        {starting ? <OriginalInputWaitingControl hostId={reference.hostId} receipt={starting} onRefresh={mailbox.refresh} /> : null}
        {mailbox.error ? <p>{mailbox.error}</p> : null}
        <p>部分 Agent 的首次目录信任或登录只能在原终端完成。这里不会代你同意未确认的请求。</p>
        <dl><dt>Session</dt><dd>{session.control.agentSessionId}</dd><dt>Run</dt><dd>{runId}</dd>
          {trustIssue ? <><dt>原步骤</dt><dd>{trustIssue.step}</dd><dt>目录</dt><dd>{trustIssue.workspacePath}</dd><dt>原操作</dt><dd>{trustIssue.lifecycleOperationId}</dd></> : null}</dl>
        <Button type="button" onClick={() => onOpenTerminal(session.id)}>查看原终端</Button>
      </details></div>
    {issue ? <p role="status">{issue}</p> : null}
  </section>
}
