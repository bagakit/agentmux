import { useMemo, type CSSProperties } from 'react'

export const COLLABORATION_TRANSFER_MS = 1200

export function CollaborationDispatchSignal({ pulseId, startedAt, path, length, zoom, kind }: {
  pulseId: number
  startedAt: number
  path: string
  length: number
  zoom: number
  kind: 'communication' | 'supervision'
}) {
  const delay = useMemo(() => Math.min(0, startedAt - Date.now()), [pulseId, startedAt])
  if (delay <= -COLLABORATION_TRANSFER_MS) return null
  const style = { animationDelay: `${delay}ms`, '--collaboration-transfer-duration': `${COLLABORATION_TRANSFER_MS}ms` } as CSSProperties
  if (kind === 'supervision') return <path key={pulseId} d={path} pathLength={1} style={style} className="collaboration-edge__pulse collaboration-edge__update" data-kind={kind} aria-hidden="true" />
  const screenLength = Math.max(1, length * zoom)
  return <g key={pulseId} className="collaboration-edge__transfer" aria-hidden="true">
    <path d={path} pathLength={1} className="collaboration-edge__pulse" data-kind={kind}
      style={{ ...style, '--collaboration-transfer-span': Math.min(.14, 72 / screenLength) } as CSSProperties} />
    <path d={path} pathLength={1} className="collaboration-edge__packet" data-kind={kind}
      style={{ ...style, '--collaboration-transfer-span': Math.min(.035, 14 / screenLength) } as CSSProperties} />
  </g>
}
