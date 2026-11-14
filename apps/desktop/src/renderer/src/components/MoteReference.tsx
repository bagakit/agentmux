import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ObjectLinkReference } from '@agentmux/client-ui'
import { useMoteDialogue } from '@agentmux/client-ui/use-mote-dialogue'
import { useVisibleWork } from '@agentmux/client-ui/use-visible-work'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'
import { api } from '../lib/api'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { scratchTopicsForWorkspace, scratchTopicKind } from '../lib/scratch-topic-snapshots'
import { originalTopicAddress } from '../../../shared/space-addresses'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { AgentAvatar } from './AgentAvatar'
import { agentSessionPresentationIndex } from '../lib/session-presentation'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { describeAgentDisplayState } from '../../../shared/agent-state-presentation'

const MoteIcon = semanticIconComponent('object.contact')
type Reference = Omit<ObjectLinkReference, 'target'> & { target: Extract<ObjectLinkReference['target'], { kind: 'mote' }> }
type Identity = ReturnType<typeof moteReferenceIdentity>

/** Uses the original saved directory and exact Space relation, never an Agent's cwd or a name. */
function moteReferenceIdentity(state: Pick<ReturnType<typeof useAppStore.getState>, 'config' | 'scratchTopicSnapshots' | 'spaceZoneBindings'>, spaceId: string) {
  const candidates = (state.config?.workspaces ?? []).flatMap(workspace =>
    (scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace) ?? []).flatMap(topic => {
      if (scratchTopicKind(topic.id, [topic]) !== 'mote') return []
      const address = originalTopicAddress(workspace, topic, state.spaceZoneBindings)
      if (address?.spaceId !== spaceId) return []
      return [{ workspace, topic, address, icon: topicSpaceIconTarget(workspace, topic, state.spaceZoneBindings) }]
    }))
  return candidates.length === 1 ? candidates[0]! : null
}

function MoteReferenceDetails({ reference, identity }: { reference: Reference; identity: Identity }) {
  const { uri, target } = reference
  const [copied, setCopied] = useState(false)
  const original = useMemo(() => identity ? { ...identity.address, expectedResource: {
    hostId: identity.workspace.hostId, workspaceId: identity.workspace.id, workspacePath: identity.workspace.path
  } } : undefined, [identity])
  const selection = useMemo(() => target.eventId === undefined ? { kind: 'main' as const } : { kind: 'work' as const, eventId: target.eventId }, [target.eventId])
  const revision = identity?.topic.quickMode
  const source = useMoteDialogue(api.moteDialogue.read, original, true, revision?.status === 'saved' ? revision.version : undefined, selection)
  const main = target.eventId === undefined ? source.page?.main.current : null
  const work = source.page?.links.filter(link => link.kind === 'work' && link.eventId === target.eventId) ?? []
  const hasSource = target.eventId === undefined ? Boolean(main) : work.length > 0
  return <div className="mote-reference__details">
    <header><strong>{identity?.topic.title ?? 'Mote'}</strong><small>{target.eventId === undefined ? '主对话' : '工作 thread'}</small></header>
    {reference.label ? <p className="mote-reference__quoted">{reference.label}</p> : null}
    <dl><dt>来源</dt><dd>{target.eventId === undefined ? '这位搭档的持续主对话' : '这位搭档的原工作事件'}</dd>
      {target.eventId !== undefined ? <><dt>事件</dt><dd>{target.eventId}</dd></> : null}
      {main ? <MoteReferenceActor hostId={main.hostId} sessionId={main.sessionId} /> : null}
      {work.map(link => link.kind === 'work' ? <div className="mote-reference__source" key={link.sequence}>
        <dt>承接者</dt><dd>{link.origin.recipientSessionId}<small>执行位置与当前状态未确认</small></dd>
        <dt>消息来源</dt><dd>{link.origin.hostId} · {link.origin.messageId}</dd>
      </div> : null)}
    </dl>
    {!identity ? <p role="status">原 Mote 资料尚未确认。保留准确链接，可打开原对象核对。</p>
      : source.issue ? <p role="status">{source.issue}<button type="button" className="small-button" onClick={source.refresh}>重读来源</button></p>
        : source.loading ? <p role="status">读取原来源…</p>
          : target.eventId !== undefined && !hasSource ? <p role="status">原工作事件尚未确认。链接与原工作面保留。</p>
            : !hasSource ? <p>尚未绑定主 Agent。</p> : null}
    <code>{uri}</code>
    <div className="mote-reference__actions">
      <button type="button" className="small-button" onClick={() => void api.ui.openObjectLink(uri).catch(useAppStore.getState().reportError)}>{target.eventId === undefined ? '打开主对话' : '打开原 thread'}</button>
      <button type="button" className="small-button" onClick={() => void copyTextToClipboard(uri, useAppStore.getState().reportError).then(ok => setCopied(ok))}>{copied ? '链接已复制' : '复制链接'}</button>
    </div>
  </div>
}

function MoteReferenceActor({ hostId, sessionId }: { hostId: string; sessionId: string }) {
  const actor = useAppStore(useShallow(state => {
    const matches = agentSessionPresentationIndex(state.sessions).get(sessionId)?.filter(session => session.control.hostId === hostId) ?? []
    const session = matches.length === 1 ? matches[0] : undefined
    return { name: session ? state.agentNames[session.id] ?? session.label : sessionId, state: session?.status.state }
  }))

  return <><dt>执行者</dt><dd>{actor.name}<small>{hostId} · {sessionId}{actor.state ? ' · ' + describeAgentDisplayState(actor.state).label : ' · 状态未确认'}</small></dd></>
}

/** Shared Markdown, cards and work references use the same Mote-specific identity and disclosure. */
export function MoteReference(reference: Reference) {
  const { uri, target, label } = reference
  const facts = useAppStore(useShallow(state => ({ config: state.config, scratchTopicSnapshots: state.scratchTopicSnapshots,
    spaceZoneBindings: state.spaceZoneBindings, spaceObjectIcons: state.spaceObjectIcons })))
  const identity = useMemo(() => target.spaceId === undefined ? null : moteReferenceIdentity(facts, target.spaceId), [facts.config, facts.scratchTopicSnapshots, facts.spaceZoneBindings, target.spaceId])
  const visibility = useVisibleWork<HTMLSpanElement>()
  const name = identity?.topic.title ?? 'Mote'
  const inline = label ? name + ' · ' + label : target.eventId === undefined ? name : name + ' · 工作 thread'
  const mark = identity?.icon ? <SpaceObjectIcon kind="mote" name={name} manualIcon={facts.spaceObjectIcons[identity.icon.key] ?? null}
    avatarObjectKey={identity.icon.key} avatarWorkspaceId={identity.workspace.id} avatarTopicId={identity.topic.id} visible={visibility.visible} /> : <MoteIcon size={16} />
  return <span ref={visibility.ref} className="mote-reference" data-mote-link={uri} data-mote-reference-kind={target.eventId === undefined ? 'main' : 'thread'}>
    <AgentAvatar inlineLabel={inline} label={inline} mark={mark} size={16} visible={visibility.visible}
      onOpen={() => void api.ui.openObjectLink(uri).catch(useAppStore.getState().reportError)}
      disclosure={{ label: 'Mote 引用详情', scope: uri, content: <MoteReferenceDetails key={uri} reference={reference} identity={identity} />,
        reference: () => ({ contextElement: visibility.ref.current ?? undefined, getBoundingClientRect: () => visibility.ref.current!.getBoundingClientRect() }) }} />
  </span>
}
