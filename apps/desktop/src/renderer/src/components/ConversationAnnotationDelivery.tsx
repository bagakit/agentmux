import * as Menu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Copy, LoaderCircle, Plus, Send } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ConversationAnnotation } from '@agentmux/client-ui/components/ConversationMessage'
import type { AgentMuxSpaceControlRequest, AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import type { OpenHttpLinkOrigin } from '../lib/open-destination'
import { annotationCreationRequest, annotationRecipients, formatConversationAnnotation, type AnnotationRecipient } from '../lib/conversation-annotation-delivery'
import { executorsForHost } from '../lib/executors'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useAppStore } from '../store'
import { AgentExecutorPicker } from './AgentExecutorPicker'
import { ConversationMessageAvatar } from './ConversationMessageAvatar'
import { resolveOverlayContainer } from './WindowOverlayHost'

type NewRequest = Extract<AgentMuxSpaceControlRequest, { operation: 'agent.open' }>
type Recipient = { kind: 'agent'; id: string } | { kind: 'new' }
const groups = [['project', '本项目'], ['mote', 'Mote'], ['other', '其他']] as const
function recipientFacts(state: ReturnType<typeof useAppStore.getState>) {
  return { config: state.config, sessions: state.sessions, agentNames: state.agentNames,
    timelines: state.timelines, scratchTopicSnapshots: state.scratchTopicSnapshots, spaceObjectIcons: state.spaceObjectIcons,
    executorDetections: state.executorDetections, hostExecutorInventories: state.hostExecutorInventories }
}

function RecipientAvatar({ recipient }: { recipient: AnnotationRecipient }) {
  return <ConversationMessageAvatar speaker={{ role: 'agent', id: recipient.id }} name={recipient.name}
    providerId={recipient.metadata?.providerId} project={recipient.metadata?.project} mote={recipient.metadata?.mote} size={22} />
}

/** Mounted only by the explicit editor. Queue and creation owners retain delivery facts. */
export function ConversationAnnotationDelivery({ sessionId, origin, annotation, onAccepted, onError, onPendingChange, active = true }: {
  sessionId: string
  origin: OpenHttpLinkOrigin
  annotation: ConversationAnnotation
  onAccepted(status: string): void
  onError(message: string): void
  onPendingChange?: ((pending: boolean) => void) | undefined
  active?: boolean | undefined
}) {
  const retainedFacts = useRef<ReturnType<typeof recipientFacts> | null>(null)
  const activeRef = useRef(active); activeRef.current = active
  const facts = useAppStore(useShallow(state => {
    if (active || retainedFacts.current === null) retainedFacts.current = recipientFacts(state)
    return retainedFacts.current
  }))
  const { workspace, recipients } = useMemo(() => annotationRecipients(facts, sessionId), [facts, sessionId])
  const [recipient, setRecipient] = useState<Recipient>({ kind: 'agent', id: sessionId })
  const [executor, setExecutor] = useState<string | null>(null)
  const [request, setRequest] = useState<NewRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [recipientOpen, setRecipientOpen] = useState(false)
  useEffect(() => { if (!active) setRecipientOpen(false) }, [active])
  const flight = useRef(false), accepted = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = recipient.kind === 'agent' ? recipients.find(item => item.id === recipient.id) : undefined
  const choices = executorsForHost(facts.config, workspace?.hostId, facts.executorDetections,
    workspace ? facts.hostExecutorInventories[workspace.hostId] : undefined)
  const locked = busy || request !== null

  function retainUnknown(report: AgentMuxSpaceMutationReport | null) {
    const detail = report?.issues.map(item => item.message).join(' ')
    onError(`新 Agent 的创建或首条批注尚未确认。原请求已保留；请检查同一请求，不会再次创建或发送。${detail ? ` ${detail}` : ''}`)
  }
  function acceptCreation(report: AgentMuxSpaceMutationReport) {
    if (report.requestId !== request?.requestId && request) { retainUnknown(null); return }
    if (!report.agent || report.agent.initialPrompt !== 'confirmed' || report.agent.creationPersistence === 'unconfirmed' || report.agent.creationFailure) { retainUnknown(report); return }
    accepted.current = true
    onPendingChange?.(false)
    onAccepted(report.outcome === 'opened' ? '已创建 Agent 并提交批注' : '批注已提交给新 Agent；显示状态待确认')
  }
  async function send() {
    if (!activeRef.current || flight.current || accepted.current || !annotation.note.trim()) return
    if (request) { await inspect(); return }
    if (recipient.kind === 'agent') {
      if (!recipients.some(item => item.id === recipient.id)) { onError('所选 Agent 已不在当前观察中；批注已保留，请重新确认同一接收者。'); return }
      flight.current = true
      try {
        const admitted = useAppStore.getState().send(recipient.id, formatConversationAnnotation(annotation, sessionId), undefined, 'manual', undefined, { sourceChannel: 'message-tool' })
        if (!admitted) { onError('批注未进入发送队列，原文和批注已保留。'); return }
        accepted.current = true
        onAccepted('已加入发送队列')
      } catch (error) { onError(error instanceof Error ? error.message : String(error)) }
      finally { flight.current = false }
      return
    }
    if (!executor || !choices.some(item => item.id === executor)) { onError('请先选择这个项目执行设备上的 Agent 配置。'); return }
    let creation: NewRequest
    try { creation = annotationCreationRequest(sessionId, origin, executor, annotation, `annotation:${crypto.randomUUID()}`) }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); return }
    flight.current = true; setBusy(true); setRequest(creation); onPendingChange?.(true)
    try {
      const result = await useAppStore.getState().executeControl(creation)
      if (!mounted.current) return
      if (result.operation === 'agent.open') {
        // The returned report is bound to the exact original request, including first-prompt receipt.
        if (result.requestId !== creation.requestId) retainUnknown(null)
        else acceptCreation(result)
      } else retainUnknown(null)
    } catch (error) { if (mounted.current) onError(`创建结果未确认，原请求已保留：${error instanceof Error ? error.message : String(error)}`) }
    finally { flight.current = false; if (mounted.current) setBusy(false) }
  }
  async function inspect() {
    if (!activeRef.current || !request || flight.current || accepted.current) return
    flight.current = true; setBusy(true)
    try {
      const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: `inspect:${crypto.randomUUID()}`,
        operation: 'space.inspect', target: { requestId: request.requestId } })
      if (!mounted.current) return
      if (result.operation === 'space.inspect' && result.request?.requestId === request.requestId && result.request.report) acceptCreation(result.request.report)
      else retainUnknown(null)
    } catch (error) { if (mounted.current) onError(`原请求检查失败；批注仍保留：${error instanceof Error ? error.message : String(error)}`) }
    finally { flight.current = false; if (mounted.current) setBusy(false) }
  }
  return <div className="conversation-annotation-delivery">
    <div className="conversation-annotation-delivery__row">
      <Menu.Root modal={false} open={active && recipientOpen} onOpenChange={setRecipientOpen}>
        <Menu.Trigger asChild><button type="button" className="conversation-annotation-delivery__target" aria-label="选择批注接收者" disabled={locked || !active}>
          {current ? <RecipientAvatar recipient={current} /> : <Plus size={16} aria-hidden="true" />}
          <span>{recipient.kind === 'new' ? '新建 Agent' : current?.name ?? recipient.id}{current?.current ? <small>当前</small> : null}</span><ChevronDown size={12} aria-hidden="true" />
        </button></Menu.Trigger>
        <Menu.Portal container={resolveOverlayContainer()}><div className="window-overlay-host__entry" data-overlay-layer="dialog">
          <Menu.Content className="tab-context-menu conversation-annotation-delivery__menu" align="start" sideOffset={5} collisionPadding={8} aria-label="批注接收者">
            <Menu.RadioGroup value={recipient.kind === 'new' ? 'new-agent' : `agent:${recipient.id}`} onValueChange={value => {
              if (locked || !activeRef.current) return
              setRecipient(value === 'new-agent' ? { kind: 'new' } : { kind: 'agent', id: value.slice(6) })
              if (value === 'new-agent' && workspace) void useAppStore.getState().detectExecutors(workspace.hostId)
            }}>
              {groups.filter(([group]) => group === 'project' || recipients.some(item => item.group === group)).map(([group, label]) => <Menu.Group key={group}>
                <Menu.Label className="conversation-annotation-delivery__group">{label}</Menu.Label>
                {recipients.filter(item => item.group === group).map(item => <Menu.RadioItem key={item.id} value={`agent:${item.id}`} data-annotation-recipient={item.id}
                  textValue={item.name} className="tab-context-menu__item conversation-annotation-delivery__option">
                  <span aria-hidden="true" inert><RecipientAvatar recipient={item} /></span>
                  <span title={item.id}><strong>{item.name}</strong><small>{item.current ? '当前 Agent' : item.metadata?.project?.name ?? item.metadata?.mote?.name ?? item.id}</small></span>
                  <Menu.ItemIndicator><Check size={13} aria-hidden="true" /></Menu.ItemIndicator>
                </Menu.RadioItem>)}
                {group === 'project' ? <Menu.RadioItem value="new-agent" disabled={!workspace} textValue="新建 Agent"
                  className="tab-context-menu__item conversation-annotation-delivery__option" title={workspace ? `在 ${workspace.name} 的原执行目录新建` : '原执行项目尚未确认'}>
                  <Plus size={18} aria-hidden="true" /><span><strong>新建 Agent</strong><small>{workspace?.name ?? '原执行项目未确认'}</small></span>
                  <Menu.ItemIndicator><Check size={13} aria-hidden="true" /></Menu.ItemIndicator>
                </Menu.RadioItem> : null}
              </Menu.Group>)}
            </Menu.RadioGroup>
          </Menu.Content>
        </div></Menu.Portal>
      </Menu.Root>
      <button type="button" className="conversation-annotation-delivery__send" aria-label={request ? '检查原批注请求' : '发送批注'}
        disabled={!active || busy || !annotation.note.trim() || (recipient.kind === 'new' && !request && !executor)} onClick={() => void send()}>
        {busy ? <LoaderCircle size={14} aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}{request ? '检查原请求' : '发送'}
      </button>
    </div>
    {recipient.kind === 'new' && active ? <AgentExecutorPicker presentation="field" label="新 Agent 配置" unsetLabel="选择 Agent 配置" executors={choices}
      selected={executor} onSelect={value => { if (activeRef.current) setExecutor(value || null) }} disabled={locked || !active} /> : null}
    {request ? <div className="conversation-annotation-delivery__request" role="status"><span>创建待确认</span><code title={request.requestId}>{request.requestId}</code>
      <button type="button" className="icon-button" aria-label="复制批注请求 ID" title={copied ? '已复制' : '复制请求 ID'} onClick={() => {
        void copyTextToClipboard(request.requestId, error => onError(`复制失败：${error instanceof Error ? error.message : String(error)}`)).then(success => { if (mounted.current) setCopied(success) })
      }}><Copy size={12} /></button>
    </div> : null}
  </div>
}
