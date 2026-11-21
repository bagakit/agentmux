import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AvatarGroup } from '@agentmux/client-ui/components/AvatarGroup'
import { compactReferenceId } from '@agentmux/client-ui/display-name'
import { agentRegionExecutionForSession, agentRegionLocationBindings, useAppStore } from '../store'
import type { FocusContext } from '../lib/focus-context'
import { sessionWorkbenchLocationChoices, workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { focusTakeoverRecipients, focusTakeoverRuntime, type FocusTakeoverRecipient } from '../lib/focus-takeover-recipients'
import { createFirstPromptSelector, sessionPresentationById } from '../lib/session-presentation'
import { agentDisplayName } from '../lib/workbench-tabs'
import { AgentOperationFeedback } from './AgentOperationFeedback'
import { executorAvatarAppearance, ResolvedAgentAvatar } from './AgentAvatar'
import * as Menu from './HoverDropdownMenu'
import '@agentmux/client-ui/styles/avatar-group.css'
import '../styles/focus-takeover-recipients.css'

const NONE: readonly FocusTakeoverRecipient[] = []
const VISIBLE_FACES = 3

function openRecipient(recipient: FocusTakeoverRecipient) {
  const state = useAppStore.getState(), current = sessionPresentationById(state.sessions).get(recipient.sessionId)
  if (current?.kind === 'agent' && current.control.agentSessionId === recipient.subject.agentSessionId &&
    current.control.hostId === recipient.subject.hostId && current.creation?.createOperationId === recipient.operationId &&
    focusTakeoverRuntime(current, agentRegionLocationBindings()) === recipient.runtimeId) {
    const choices = sessionWorkbenchLocationChoices(state.tabs, workbenchSelectionCatalog(state), recipient.sessionId).filter(reference => {
      return agentRegionExecutionForSession(reference, current)?.runtimeId === recipient.runtimeId
    })
    if (choices.length === 1) {
      state.selectSession(recipient.sessionId, undefined, { reference: choices[0]! })
      return
    }
    if (choices.length > 1 && state.requestSessionLocations(recipient.sessionId, { keepSurface: false,
      subject: { hostId: current.control.hostId, agentSessionId: current.control.agentSessionId, runtimeId: recipient.runtimeId,
        expectedRunId: current.control.run.runId } })) return
  }
  state.reportError(new Error('暂时无法打开这位 Agent 的原位置。可以从 Agent 详情核对接手记录。'), { kind: 'indeterminate' })
}

function RecipientGroup({ recipients, onOpen }: { recipients: readonly FocusTakeoverRecipient[]; onOpen(): void }) {
  const prompts = useMemo(() => recipients.map(recipient => createFirstPromptSelector(recipient.sessionId)), [recipients])
  const labels = useAppStore(useShallow(state => recipients.map((recipient, index) => agentDisplayName({
    userName: state.agentNames[recipient.sessionId], firstPrompt: prompts[index]!(state),
    fallbackLabel: recipient.label, providerLabel: recipient.providerId,
  }))))
  const config = useAppStore(state => state.config)
  const counts = new Map<string, number>()
  for (const name of labels) counts.set(name, (counts.get(name) ?? 0) + 1)
  const faces = recipients.map((recipient, index) => {
    const name = labels[index]!
    const status = recipient.continued ? '继续了这份工作' : '已创建，交接待确认'
    const origin = (counts.get(name) ?? 0) > 1 ? `${recipient.subject.hostId} · ${compactReferenceId(recipient.runtimeId)} · ${compactReferenceId(recipient.subject.agentSessionId)}` : undefined
    const avatar = <ResolvedAgentAvatar label={name} providerId={recipient.providerId} executorId={recipient.executorId}
      appearance={executorAvatarAppearance(config, recipient.executorId)} size={20} />
    return { recipient, name, status, avatar, origin }
  })
  const button = ({ recipient, name, status, avatar, origin }: typeof faces[number], showName = false) =>
    <button className="focus-takeover-recipients__agent" type="button" aria-label={origin ? `打开 ${name} · ${origin}` : `打开 ${name}`}
      title={showName ? name : [name, status, origin].filter(Boolean).join(' · ')} onClick={() => { onOpen(); openRecipient(recipient) }}>
      {avatar}{showName ? <span className="focus-takeover-recipients__single-text"><strong>{name}</strong>{' '}<span>{status}</span></span> : null}
    </button>
  if (faces.length === 1) {
    const face = faces[0]!
    return <div className="focus-takeover-recipients" data-focus-takeover-recipients>{button(face, true)}</div>
  }
  const continued = recipients.filter(recipient => recipient.continued).length
  const waiting = recipients.length - continued
  const summary = !continued ? `${waiting} 位交接待确认` : !waiting ? `${continued} 位 Agent 继续了这份工作`
    : `${continued} 位已继续 · ${waiting} 位待确认`
  const overflow = faces.length > VISIBLE_FACES
  const listLabel = `查看全部 ${faces.length} 个接手 Agent`
  return <Menu.Root onOpenChange={open => { if (open) onOpen() }}>
    <div className="focus-takeover-recipients" data-focus-takeover-recipients>
    <AvatarGroup label="接手 Agent" max={VISIBLE_FACES} interactive items={faces.map(face => ({
      key: face.recipient.key, label: face.name, avatar: button(face),
    }))} overflow={overflow ?
      <Menu.Trigger className="focus-takeover-recipients__more" type="button" aria-label={listLabel}>
        +{faces.length - VISIBLE_FACES}
      </Menu.Trigger> : undefined} />
      {overflow ? <span>{summary}</span> : <Menu.Trigger className="focus-takeover-recipients__summary"
        type="button" aria-label={listLabel}>{summary}</Menu.Trigger>}
    </div>
    <Menu.Portal><Menu.Content className="tab-context-menu focus-takeover-recipients__menu" align="start" sideOffset={5} collisionPadding={8}>
      {faces.map(({ recipient, name, status, avatar, origin }) => <Menu.Item className="tab-context-menu__item" key={recipient.key}
        aria-label={origin ? `打开 ${name} · ${origin}` : `打开 ${name}`} onSelect={() => openRecipient(recipient)}>
        {avatar}<span><strong>{name}</strong><small>{status}</small>{origin ? <small>{origin}</small> : null}</span>
      </Menu.Item>)}
    </Menu.Content></Menu.Portal>
  </Menu.Root>
}

/** The same Focus card can show a known outcome and another original request still in flight. */
export function FocusTakeoverFeedback({ context, active, onOpen, onCardDismiss }: { context: FocusContext; active: boolean; onOpen(): void; onCardDismiss?(): void }) {
  const recipients = useAppStore(state => {
    if (!active) return NONE
    const regions = agentRegionLocationBindings()
    const session = context.control && !context.access ? sessionPresentationById(state.sessions).get(context.id) : undefined
    const ordinary = session?.kind === 'agent' && session.control.hostId === context.control?.hostId &&
      session.control.agentSessionId === context.control?.agentSessionId && session.control.run.runId === context.control.run.runId
    const runtimeId = context.access?.identity.runtimeId ?? (ordinary ? focusTakeoverRuntime(session, regions) : undefined)
    const agentSessionId = context.access?.identity.agentSessionId ?? context.control?.agentSessionId
    return runtimeId && agentSessionId ? focusTakeoverRecipients(state.sessions, regions, { runtimeId, agentSessionId }) : NONE
  })
  return <>
    {recipients.length ? <RecipientGroup recipients={recipients} onOpen={onOpen} /> : null}
    {!context.access && context.control ? <AgentOperationFeedback subject={context.control} onCardDismiss={onCardDismiss} /> : null}
  </>
}
