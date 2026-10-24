import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentMuxRpcResult } from '@agentmux/core'
import type { AgentMuxMotePresentation, AgentMuxSpaceAddress } from '@agentmux/core/control'
import { MoteFace, type MoteExpression } from '@agentmux/client-ui/components/MoteFace'
import { isMoteFace } from '@agentmux/client-ui/mote-face'
import { observeMoteMotion } from '@agentmux/client-ui/mote-face-motion'
import '@agentmux/client-ui/styles/mote-identity.css'
import { SPACE_ICON_CATALOG } from '@agentmux/client-ui/space-icon-catalog'
import { MobileSpaceIcon } from './MobileSpaceIcon'
import { MoteIcon as MoteMark } from '@agentmux/client-ui/components/MoteIcon'
import { MobileAvatarNotice } from '../notices/MobileNotice'
const ThemeStatusWarningIcon = semanticIconComponent('status.warning')
type Catalog = AgentMuxRpcResult<'space.ls'>['catalog']
export type MobileObjectIdentity = { name: string; project: string; context?: AgentMuxSpaceAddress;
  mote?: { spaceId: string; name?: string; conversationName?: string | undefined; contentReference?: AgentMuxMotePresentation['content']; facts?: AgentMuxMotePresentation | undefined; appearance?: NonNullable<Catalog['appearance']>[number] | undefined } }
export function MobileIdentity({ identity, session, client, connected, size = 32, visible = true, objectSpaceId, appearance, appearanceRevision }: {
  identity: MobileObjectIdentity; session?: AgentMuxAgentSession | undefined; client: AgentMuxHostedClient | null; connected: boolean; size?: number; visible?: boolean; objectSpaceId?: string | null | undefined; appearanceRevision?: number | undefined; appearance?: NonNullable<Catalog['appearance']>[number] | undefined
}) {
  // Static bytes belong to the source space; runtime activity and failures
  // additionally belong to the exact Session and Run that observed them.
  const appearanceOwner = useMemo(() => ({}), [client, identity.mote?.spaceId])
  const sourceOwner = useMemo(() => ({}), [appearanceOwner, session?.agentSessionId, session?.hostId, session?.run.runId])
  const observationOwner = useMemo(() => ({}), [sourceOwner, connected, visible])
  const [liveAppearance, setLiveAppearance] = useState<{ spaceId: string; value: NonNullable<Catalog['appearance']>[number]; source: object; owner: object; requestStartedMono: number | null } | null>(null)
  const [clock, wake] = useState(0)
  const selected = liveAppearance && liveAppearance.source === appearanceOwner && liveAppearance.spaceId === identity.mote?.spaceId ? liveAppearance.value : identity.mote?.appearance
  const [image, setImage] = useState<{ spaceId: string; source: object; dataUrl: string; revision?: string | undefined } | null>(null)
  const confirmedImage = useRef<typeof image>(null)
  const [failure, setFailure] = useState<{ owner: object; message: string } | null>(null)
  const [retryRequest, setRetryRequest] = useState<{ owner: object; revision: number } | null>(null)
  const retryRevision = retryRequest?.owner === sourceOwner ? retryRequest.revision : 0
  const issue = failure?.owner === sourceOwner ? failure.message : ''
  const setIssue = (message: string) => setFailure({ owner: sourceOwner, message })
  const spaceId = identity.mote?.spaceId
  useEffect(() => {
    if (!visible || !spaceId || !connected || !client?.forwardRpc || !session && !selected?.image) return
    let live = true, reading = false, dirty = false, epoch = 0
    let attemptedImage: string | undefined, imageIssue = ''
    const invalidateActivity = () => setLiveAppearance(value => value?.owner === observationOwner ? { ...value, requestStartedMono: null } : value)
    async function read() {
      if (!live || document.hidden || !ref.current?.getClientRects().length) return
      if (reading) { dirty = true; epoch++; return }
      reading = true
      const generation = epoch, requestStartedMono = performance.now()
      try {
        // Activity reads carry the original revision, without re-reading image bytes for every tool event.
        const value = await client!.forwardRpc!('space.ls', { target: { spaceId: spaceId! }, presentation: true })
        if (!live || generation !== epoch) return
        const original = value.catalog.appearance?.find(item => item.spaceId === spaceId)
        if (!original) { invalidateActivity(); setIssue('原头像外观尚未确认，已保存选择保留。'); return }
        const imageKey = original.image ? JSON.stringify([spaceId, original.image.revision ?? null]) : undefined
        const confirmed = original.image && confirmedImage.current?.source === appearanceOwner && confirmedImage.current?.spaceId === spaceId && confirmedImage.current?.revision === original.image.revision
        if (confirmed || !original.image) imageIssue = ''
        if (original.image && !confirmed && attemptedImage !== imageKey) {
          attemptedImage = imageKey
          const detail = await client!.forwardRpc!('space.inspect', { target: { spaceId: spaceId! }, presentation: true })
          if (!live || generation !== epoch) return
          const imageFact = detail.catalog.appearance?.find(item => item.spaceId === spaceId)
          if (!imageFact?.image?.dataUrl || imageFact.image.revision !== original.image.revision) {
            setLiveAppearance({ spaceId: spaceId!, value: original, source: appearanceOwner, owner: observationOwner, requestStartedMono })
            imageIssue = imageFact?.issue ?? '原头像内容或修订尚未确认；已保存选择保留，可刷新原呈现。'
            setIssue(imageIssue); return
          }
          const next = { spaceId: spaceId!, source: appearanceOwner, dataUrl: imageFact.image.dataUrl, revision: imageFact.image.revision }
          confirmedImage.current = next; setImage(next); imageIssue = ''
        }
        setLiveAppearance({ spaceId: spaceId!, value: original, source: appearanceOwner, owner: observationOwner, requestStartedMono })
        setIssue(original.issue ?? imageIssue)
      } catch (error) { if (live && generation === epoch) { invalidateActivity(); imageIssue = error instanceof Error ? error.message : '原头像暂不可读。'; setIssue(imageIssue) } }
      finally { reading = false; if (live && dirty) { dirty = false; void read() } }
    }
    const release = client.onEvent(event => {
      if (event.type === 'connection-state' && event.state === 'restored' ||
          event.type === 'agent-session' && event.session.agentSessionId === session?.agentSessionId ||
          event.type === 'agent-timeline' && event.agentSessionId === session?.agentSessionId) void read()
    })
    const foreground = () => { if (document.hidden) { epoch++; invalidateActivity() } else void read() }
    document.addEventListener('visibilitychange', foreground)
    void read()
    return () => { live = false; epoch++; release(); document.removeEventListener('visibilitychange', foreground) }
  }, [spaceId, identity.mote?.appearance, appearanceRevision, client, connected, session?.agentSessionId, visible, observationOwner, sourceOwner, appearanceOwner, retryRevision])
  const expressions = ['identity', 'sleep', 'idle', 'thinking', 'tool', 'starting', 'waiting', 'error', 'unknown', 'stopped']
  const activitySource = liveAppearance?.owner === observationOwner ? liveAppearance : null
  const activity = session ? activitySource?.value.activities?.find(value => value.agentSessionId === session.agentSessionId && value.runId === session.run.runId) : undefined
  const originalExpression = session ? activity?.expression : selected?.expression
  const working = originalExpression === 'thinking' || originalExpression === 'tool'
  // The remote duration is anchored before this exact request. Deduct the whole RTT;
  // phone and Host wall clocks need not agree, and cached props cannot renew activity.
  const deadline = activitySource?.requestStartedMono !== null && activitySource?.requestStartedMono !== undefined &&
    activity && session && activity.hostId === session.hostId && typeof activity.activeForMs === 'number'
    ? activitySource.requestStartedMono + activity.activeForMs : null
  const workCurrent = !working || deadline !== null && performance.now() < deadline
  const expression: MoteExpression = connected && workCurrent && originalExpression && expressions.includes(originalExpression) ? originalExpression as MoteExpression : 'unknown'
  useEffect(() => {
    if (!working || !workCurrent || deadline === null || !connected || !visible || document.hidden) return
    const timer = setTimeout(() => wake(value => value + 1), Math.max(1, deadline - performance.now()))
    return () => clearTimeout(timer)
  }, [working, workCurrent, deadline, connected, visible, clock])
  const face = selected?.parts && isMoteFace(selected.parts) ? selected.parts : null
  const motionSource = face ? 'face' : selected?.image ? 'image' : selected?.glyph ? 'glyph' : 'automatic'
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (!identity.mote || !ref.current) return
    const motion = observeMoteMotion(ref.current, expression, visible)
    return () => motion.dispose()
  }, [expression, spaceId, visible, motionSource])
  const Glyph = selected?.glyph && Object.hasOwn(SPACE_ICON_CATALOG, selected.glyph) ? SPACE_ICON_CATALOG[selected.glyph as keyof typeof SPACE_ICON_CATALOG].Icon : null
  const avatarIssue = issue || (liveAppearance?.owner === observationOwner ? liveAppearance.value.issue : identity.mote?.appearance?.issue) || ''
  return <><span ref={ref} className={identity.mote ? 'mobile-object-avatar mote-identity-motion' : 'mobile-object-avatar mobile-project-avatar'}
    data-mote-expression={expression} data-mote-motion="off" style={{ width: size, height: size, '--mote-ambient-delay': `-${Array.from(spaceId ?? '').reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0) % 14000}ms` } as import('react').CSSProperties} title={avatarIssue || identity.name}>
    {identity.mote ? <span className="space-object-icon">{face ? <span className="mobile-mote-face-model" style={{ transform: `scale(${size / 64})` }}><MoteFace face={face} expression={expression} /></span>
      : selected?.image ? image && image.source === appearanceOwner && image.spaceId === spaceId && image.revision === selected.image.revision ? <img className="space-object-icon__avatar" src={image.dataUrl} alt="" /> : <MoteMark size={size - 8} />
      : selected?.glyph ? Glyph ? <Glyph size={size - 8} /> : <MoteMark size={size - 8} /> : <MoteMark size={size - 8} interactive={visible} data-mote-icon-source="automatic" />}</span>
      : <MobileSpaceIcon appearanceRevision={appearanceRevision} spaceId={objectSpaceId ?? identity.context?.spaceId} name={identity.project || identity.name} appearance={appearance} client={client} connected={connected} visible={visible} size={size - 8} />}
    {avatarIssue && <span className="mobile-avatar-issue" aria-label={avatarIssue}><ThemeStatusWarningIcon size={10} /></span>}
  </span>{identity.mote && <MobileAvatarNotice owner={client} identity={[spaceId, session?.hostId, session?.agentSessionId, session?.run.runId, avatarIssue]} name={identity.mote.name ?? 'Mote 名称未确认'}
    issue={avatarIssue} visible={visible} {...(spaceId && connected && client?.forwardRpc ? { retry: () => setRetryRequest(value => ({ owner: sourceOwner, revision: value?.owner === sourceOwner ? value.revision + 1 : 1 })) } : {})} />}</>
}
