import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceAppearance } from '@agentmux/core/control'
import { SpaceAppearanceIcon } from '@agentmux/client-ui/components/SpaceAppearanceIcon'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { MobileAvatarNotice } from '../notices/MobileNotice'

/** Only a visible original object asks its existing appearance owner for image bytes. */
export function MobileSpaceIcon({ spaceId, name, appearance, client, connected, visible, size, appearanceRevision = 0 }: {
  spaceId?: string | null | undefined; name: string; appearance?: AgentMuxSpaceAppearance | undefined
  client: AgentMuxHostedClient | null; connected: boolean; visible: boolean; size: number; appearanceRevision?: number | undefined
}) {
  const node = useRef<HTMLSpanElement>(null)
  const reference = JSON.stringify([spaceId, appearance?.glyph, appearance?.image?.revision, appearance?.preset])
  const observationOwner = useMemo(() => ({}), [client, reference])
  const [observed, setObserved] = useState<{ id: string; owner: object; input: AgentMuxSpaceAppearance | undefined; value: AgentMuxSpaceAppearance } | null>(null)
  const [failure, setFailure] = useState<{ owner: object; message: string } | null>(null)
  const issue = failure?.owner === observationOwner ? failure.message : ''
  const [retryRequest, setRetryRequest] = useState<{ owner: object; revision: number } | null>(null)
  const retryRevision = retryRequest?.owner === observationOwner ? retryRequest.revision : 0
  const setIssue = (message: string) => setFailure({ owner: observationOwner, message })
  useEffect(() => {
    if (!spaceId || !client?.forwardRpc || !connected || !visible || appearance?.glyph && retryRevision === 0) return
    let live = true, requested = false
    const read = async () => {
      if (!live || requested || document.hidden) return
      requested = true
      try {
        const result = await client.forwardRpc!('space.inspect', { target: { spaceId }, presentation: true })
        const original = result.catalog.appearance?.find(value => value.spaceId === spaceId)
        if (!live) return
        if (!original) { setIssue('原对象图标尚未确认，可刷新原目录。'); return }
        setObserved({ id: spaceId, owner: observationOwner, input: appearance, value: original }); setIssue(original.issue ?? '')
      } catch (error) { if (live) setIssue(error instanceof Error ? error.message : String(error)) }
    }
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { void read(); if (requested) observer!.disconnect() }
    }) : null
    if (observer && node.current) observer.observe(node.current)
    else void read()
    const foreground = () => { if (!document.hidden && node.current && node.current.getBoundingClientRect().bottom >= 0 && node.current.getBoundingClientRect().top <= window.innerHeight) { void read(); if (requested) observer?.disconnect() } }
    document.addEventListener('visibilitychange', foreground)
    return () => { live = false; observer?.disconnect(); document.removeEventListener('visibilitychange', foreground) }
  }, [client, connected, visible, reference, appearanceRevision, observationOwner, retryRevision])
  // A fresh directory response may recreate an equivalent input object. Keep the
  // confirmed observation in that case, but honor a changed incoming fact.
  const inputMatches = observed?.input?.glyph === appearance?.glyph && observed?.input?.preset === appearance?.preset &&
    observed?.input?.image?.revision === appearance?.image?.revision && observed?.input?.image?.dataUrl === appearance?.image?.dataUrl && observed?.input?.issue === appearance?.issue
  const selected = observed && observed.owner === observationOwner && observed.id === spaceId && inputMatches ? observed.value : appearance
  return <><span ref={node} className="mobile-space-icon" title={issue || selected?.issue || name} data-space-icon-source={selected?.glyph ? 'manual' : selected?.image?.dataUrl ? 'image' : 'automatic'}>
    <SpaceAppearanceIcon name={name} glyph={selected?.glyph} image={selected?.image?.dataUrl} preset={selected?.preset} size={size} />
    {(issue || selected?.issue) && <span className="mobile-avatar-issue" aria-label={issue || selected?.issue}><SemanticIcon name="status.warning" size={10} /></span>}
  </span><MobileAvatarNotice owner={client} identity={[spaceId, issue || selected?.issue]} name={name} issue={issue || selected?.issue || ''} visible={visible}
    {...(spaceId && connected && client?.forwardRpc ? { retry: () => setRetryRequest(value => ({ owner: observationOwner, revision: value?.owner === observationOwner ? value.revision + 1 : 1 })) } : {})} /></>
}
