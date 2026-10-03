import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentMuxRpcResult } from '@agentmux/core'
import { MoteFace, type MoteExpression } from '@agentmux/client-ui/components/MoteFace'
import { isMoteFace } from '@agentmux/client-ui/mote-face'
import { observeMoteMotion } from '@agentmux/client-ui/mote-face-motion'
import '@agentmux/client-ui/styles/mote-identity.css'
import { SPACE_ICON_CATALOG } from '@agentmux/client-ui/space-icon-catalog'
import { MoteMark } from './MoteMark'
import defaultAvatar from './mote-avatar.png'
type Catalog = AgentMuxRpcResult<'space.ls'>['catalog']
export type MobileObjectIdentity = { name: string; project: string; mote?: { spaceId: string; appearance?: NonNullable<Catalog['appearance']>[number] | undefined } }
export function MobileIdentity({ identity, session, client, connected, size = 32 }: {
  identity: MobileObjectIdentity; session?: AgentMuxAgentSession; client: AgentMuxHostedClient | null; connected: boolean; size?: number
}) {
  const selected = identity.mote?.appearance
  const [image, setImage] = useState<{ spaceId: string; dataUrl: string } | null>(null)
  const [issue, setIssue] = useState('')
  const spaceId = identity.mote?.spaceId
  useEffect(() => {
    if (!spaceId || !selected?.image || !connected || !client?.forwardRpc) return
    let live = true
    void client.forwardRpc('space.inspect', { target: { spaceId }, presentation: true }).then(value => {
      const original = value.catalog.appearance?.find(item => item.spaceId === spaceId)
      if (!live) return
      if (original?.image?.dataUrl) { setImage({ spaceId, dataUrl: original.image.dataUrl }); setIssue('') }
      else setIssue(original?.issue ?? '原头像暂不可读，保存的选择保留。')
    }).catch(error => { if (live) setIssue(error instanceof Error ? error.message : '原头像暂不可读。') })
    return () => { live = false }
  }, [spaceId, Boolean(selected?.image), selected?.image?.revision, client, connected])
  const state = session?.semanticStatus?.state
  const expression: MoteExpression = !connected ? 'unknown' : session?.pendingInteraction || state === 'waiting' || state === 'blocked' ? 'waiting'
    : state === 'working' ? 'thinking' : state === 'starting' ? 'starting' : state === 'error' ? 'error' : state === 'exited' ? 'stopped' : session ? 'idle' : 'identity'
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (!identity.mote || !ref.current) return
    const motion = observeMoteMotion(ref.current, expression, true)
    return () => motion.dispose()
  }, [expression, spaceId])
  const Glyph = selected?.glyph && Object.hasOwn(SPACE_ICON_CATALOG, selected.glyph) ? SPACE_ICON_CATALOG[selected.glyph as keyof typeof SPACE_ICON_CATALOG].Icon : null
  const face = selected?.parts && isMoteFace(selected.parts) ? selected.parts : null
  return <span ref={ref} className={identity.mote ? 'mobile-object-avatar mote-identity-motion' : 'mobile-object-avatar mobile-project-avatar'}
    data-mote-expression={expression} data-mote-motion="off" style={{ width: size, height: size }} title={issue || identity.name}>
    {identity.mote ? <span className="space-object-icon">{face ? <MoteFace face={face} expression={expression} />
      : selected?.image ? image && image.spaceId === spaceId ? <img className="space-object-icon__avatar" src={image.dataUrl} alt="" /> : <MoteMark size={size - 8} />
      : selected?.glyph ? Glyph ? <Glyph size={size - 8} /> : <MoteMark size={size - 8} /> : <img className="space-object-icon__avatar" src={defaultAvatar} alt="" />}</span>
      : <span>{Array.from(identity.project || identity.name).slice(0, 1).join('').toLocaleUpperCase()}</span>}
    {issue && <span className="mobile-avatar-issue" aria-label={issue}>!</span>}
  </span>
}
