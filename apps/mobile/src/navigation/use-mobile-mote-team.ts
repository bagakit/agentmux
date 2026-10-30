import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { mobileMoteTeam } from './mobile-mote-team'

/** One visible Mote reader. No member history scan or second role/notification store. */
export function useMobileMoteTeam(client: AgentMuxHostedClient | null, spaceId: string | null, connected: boolean, active: boolean) {
  const [reading, setReading] = useState<{ client: typeof client; spaceId: string; catalog: AgentMuxSpaceCatalog } | null>(null)
  const [failure, setFailure] = useState<{ client: typeof client; spaceId: string; message: string } | null>(null)
  const [revision, refresh] = useState(0)
  const [sessionRevision, updateSessions] = useState(0)
  const original = reading?.client === client && reading.spaceId === spaceId ? reading : null
  const team = useMemo(() => original ? mobileMoteTeam(original.catalog, original.spaceId, client) : null, [original, client, sessionRevision])
  const members = useRef(new Set<string>()); members.current = new Set(team?.members.map(member => member.sessionId))
  useEffect(() => {
    if (!client || !spaceId || !connected || !active) return
    let live = true, inFlight = false, dirty = false
    const read = async () => {
      if (!live || document.hidden) return
      if (inFlight) { dirty = true; return }
      inFlight = true
      try {
        if (!client.forwardRpc) throw new Error('原团队读取端口暂不可用；原对话保留。')
        const owner = client.runtimeOwnerIdentity?.()
        const result = await client.forwardRpc('space.ls', { target: { spaceId }, presentation: true })
        const current = client.runtimeOwnerIdentity?.()
        if (!live) return
        if (owner?.runtimeId !== current?.runtimeId || owner?.ownerInstanceId !== current?.ownerInstanceId)
          throw new Error('读取期间原 Mac 归属已变化，原团队引用保留，请刷新核对。')
        if (!mobileMoteTeam(result.catalog, spaceId, client)) throw new Error('原 Mote 范围尚未确认，原成员和会话保留。')
        setReading({ client, spaceId, catalog: result.catalog }); setFailure(null)
      } catch (error) { if (live) setFailure({ client, spaceId, message: error instanceof Error ? error.message : String(error) }) }
      finally { inFlight = false; if (dirty && live) { dirty = false; void read() } }
    }
    void read()
    const release = client.onEvent(event => {
      if (event.type === 'agent-session' && members.current.has(event.session.agentSessionId)) { updateSessions(value => value + 1); void read() }
      if (event.type === 'connection-state' && event.state === 'restored') void read()
    })
    const foreground = () => { if (!document.hidden) void read() }
    document.addEventListener('visibilitychange', foreground)
    return () => { live = false; release(); document.removeEventListener('visibilitychange', foreground) }
  }, [client, spaceId, connected, active, revision])
  return { team, issue: failure?.client === client && failure.spaceId === spaceId ? failure.message :
    !connected ? '连接暂不可用；原团队与会话保留。' : null, refresh: () => refresh(value => value + 1) }
}
