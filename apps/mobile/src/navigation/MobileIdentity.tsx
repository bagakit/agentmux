import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentMuxRpcResult } from '@agentmux/core'
import type { AgentMuxMotePresentation, AgentMuxSpaceAddress } from '@agentmux/core/control'
import { MoteFace, type MoteExpression } from '@agentmux/client-ui/components/MoteFace'
import { isMoteFace } from '@agentmux/client-ui/mote-face'
import { observeMoteMotion } from '@agentmux/client-ui/mote-face-motion'
import '@agentmux/client-ui/styles/mote-identity.css'
import { SPACE_ICON_CATALOG } from '@agentmux/client-ui/space-icon-catalog'
import { MoteIcon as MoteMark } from '@agentmux/client-ui/components/MoteIcon'
import defaultAvatar from './mote-avatar.png'
const ThemeStatusWarningIcon = semanticIconComponent('status.warning')
type Catalog = AgentMuxRpcResult<'space.ls'>['catalog']
export type MobileObjectIdentity = { name: string; project: string; context?: AgentMuxSpaceAddress;
  mote?: { spaceId: string; name?: string; conversationName?: string | undefined; contentReference?: AgentMuxMotePresentation['content']; facts?: AgentMuxMotePresentation | undefined; appearance?: NonNullable<Catalog['appearance']>[number] | undefined } }
export function MobileIdentity({ identity, session, client, connected, size = 32, visible = true }: {
  identity: MobileObjectIdentity; session?: AgentMuxAgentSession | undefined; client: AgentMuxHostedClient | null; connected: boolean; size?: number; visible?: boolean
}) {
  const [liveAppearance, setLiveAppearance] = useState<{ spaceId: string; value: NonNullable<Catalog['appearance']>[number] } | null>(null)
  const selected = liveAppearance && liveAppearance.spaceId === identity.mote?.spaceId ? liveAppearance.value : identity.mote?.appearance
  const [image, setImage] = useState<{ spaceId: string; dataUrl: string; revision?: string | undefined } | null>(null)
  const confirmedImage = useRef<typeof image>(null)
  const [issue, setIssue] = useState('')
  const spaceId = identity.mote?.spaceId
  useEffect(() => {
    if (!visible || !spaceId || !connected || !client?.forwardRpc || !session && !selected?.image) return
    let live = true, reading = false, dirty = false, epoch = 0
    let attemptedImage: string | undefined, imageIssue = ''
    async function read() {
      if (!live || document.hidden || !ref.current?.getClientRects().length) return
      if (reading) { dirty = true; epoch++; return }
      reading = true
      const generation = epoch
      try {
        // Activity reads carry the original revision, without re-reading image bytes for every tool event.
        const value = await client!.forwardRpc!('space.ls', { target: { spaceId: spaceId! }, presentation: true })
        if (!live || generation !== epoch) return
        const original = value.catalog.appearance?.find(item => item.spaceId === spaceId)
        if (!original) { setIssue('原头像外观尚未确认，已保存选择保留。'); return }
        const imageKey = original.image ? JSON.stringify([spaceId, original.image.revision ?? null]) : undefined
        const confirmed = original.image && confirmedImage.current?.spaceId === spaceId && confirmedImage.current?.revision === original.image.revision
        if (confirmed || !original.image) imageIssue = ''
        if (original.image && !confirmed && attemptedImage !== imageKey) {
          attemptedImage = imageKey
          const detail = await client!.forwardRpc!('space.inspect', { target: { spaceId: spaceId! }, presentation: true })
          if (!live || generation !== epoch) return
          const imageFact = detail.catalog.appearance?.find(item => item.spaceId === spaceId)
          if (!imageFact?.image?.dataUrl || imageFact.image.revision !== original.image.revision) {
            setLiveAppearance({ spaceId: spaceId!, value: original })
            imageIssue = imageFact?.issue ?? '原头像内容或修订尚未确认；已保存选择保留，可刷新原呈现。'
            setIssue(imageIssue); return
          }
          const next = { spaceId: spaceId!, dataUrl: imageFact.image.dataUrl, revision: imageFact.image.revision }
          confirmedImage.current = next; setImage(next); imageIssue = ''
        }
        setLiveAppearance({ spaceId: spaceId!, value: original })
        setIssue(original.issue ?? imageIssue)
      } catch (error) { if (live && generation === epoch) { imageIssue = error instanceof Error ? error.message : '原头像暂不可读。'; setIssue(imageIssue) } }
      finally { reading = false; if (live && dirty) { dirty = false; void read() } }
    }
    const release = client.onEvent(event => {
      if (event.type === 'connection-state' && event.state === 'restored' ||
          event.type === 'agent-session' && event.session.agentSessionId === session?.agentSessionId ||
          event.type === 'agent-timeline' && event.agentSessionId === session?.agentSessionId) void read()
    })
    const foreground = () => { if (!document.hidden) void read() }
    document.addEventListener('visibilitychange', foreground)
    void read()
    return () => { live = false; release(); document.removeEventListener('visibilitychange', foreground) }
  }, [spaceId, identity.mote?.appearance, client, connected, session?.agentSessionId, visible])
  const expressions = ['identity', 'sleep', 'idle', 'thinking', 'tool', 'starting', 'waiting', 'error', 'unknown', 'stopped']
  const activity = session ? selected?.activities?.find(value => value.agentSessionId === session.agentSessionId && value.runId === session.run.runId) : undefined
  const originalExpression = session ? activity?.expression : selected?.expression
  const expression: MoteExpression = connected && originalExpression && expressions.includes(originalExpression) ? originalExpression as MoteExpression : 'unknown'
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (!identity.mote || !ref.current) return
    const motion = observeMoteMotion(ref.current, expression, visible)
    return () => motion.dispose()
  }, [expression, spaceId, visible])
  const Glyph = selected?.glyph && Object.hasOwn(SPACE_ICON_CATALOG, selected.glyph) ? SPACE_ICON_CATALOG[selected.glyph as keyof typeof SPACE_ICON_CATALOG].Icon : null
  const face = selected?.parts && isMoteFace(selected.parts) ? selected.parts : null
  return <span ref={ref} className={identity.mote ? 'mobile-object-avatar mote-identity-motion' : 'mobile-object-avatar mobile-project-avatar'}
    data-mote-expression={expression} data-mote-motion="off" style={{ width: size, height: size, '--mote-ambient-delay': `-${Array.from(spaceId ?? '').reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0) % 14000}ms` } as import('react').CSSProperties} title={issue || selected?.issue || identity.name}>
    {identity.mote ? <span className="space-object-icon">{face ? <MoteFace face={face} expression={expression} />
      : selected?.image ? image && image.spaceId === spaceId && image.revision === selected.image.revision ? <img className="space-object-icon__avatar" src={image.dataUrl} alt="" /> : <MoteMark size={size - 8} />
      : selected?.glyph ? Glyph ? <Glyph size={size - 8} /> : <MoteMark size={size - 8} /> : selected?.preset === 'primary-mote' ? <img className="space-object-icon__avatar" src={defaultAvatar} alt="" /> : <MoteMark size={size - 8} />}</span>
      : <span>{Array.from(identity.project || identity.name).slice(0, 1).join('').toLocaleUpperCase()}</span>}
    {(issue || selected?.issue) && <span className="mobile-avatar-issue" aria-label={issue || selected?.issue}><ThemeStatusWarningIcon size={10} /></span>}
  </span>
}
