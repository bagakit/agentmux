import { ViewportPortal, type Node, type Rect, type XYPosition } from '@xyflow/react'
import type { ReactNode } from 'react'
import type { MeshLocation } from '../../../../shared/mesh-map-locations'
import land from './mesh-world.svg'

export const WORLD_WIDTH = 1000
export const WORLD_HEIGHT = WORLD_WIDTH / 2
const GUTTER = 16
const ROW_HEIGHT = 86
const TRAY_HEADER = 48

export function projectMeshLocation({ latitude, longitude }: MeshLocation): XYPosition {
  return { x: (longitude + 180) * WORLD_WIDTH / 360, y: (90 - latitude) * WORLD_HEIGHT / 180 }
}

export function unprojectMeshLocation({ x, y }: XYPosition): MeshLocation {
  return { latitude: 90 - y * 180 / WORLD_HEIGHT, longitude: x * 360 / WORLD_WIDTH - 180 }
}

const meridians = Array.from({ length: 11 }, (_, index) => (index - 5) * 30)
const parallels = meridians.filter(degrees => Math.abs(degrees) < 90)

export function MeshAtlas({ children }: { children?: ReactNode }) {
  return <div className="mesh-geography__atlas" aria-hidden="true">
    <img className="mesh-geography__land" src={land} alt="" draggable={false} />
    <svg className="mesh-geography__grid" viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`}>
      {meridians.map(longitude => {
        const { x } = projectMeshLocation({ longitude, latitude: 0 })
        return <line key={longitude} x1={x} x2={x} y1={0} y2={WORLD_HEIGHT} />
      })}
      {parallels.map(latitude => {
        const { y } = projectMeshLocation({ longitude: 0, latitude })
        return <line key={latitude} x1={0} x2={WORLD_WIDTH} y1={y} y2={y} data-equator={latitude === 0 || undefined} />
      })}
      {children}
    </svg>
  </div>
}

export function placeGeographicNodes<N extends Node>(nodes: readonly N[], points: ReadonlyMap<string, XYPosition>, narrow: boolean) {
  const labels: { position: XYPosition; width: number; height: number }[] = []
  const marks: { id: string; point: XYPosition; label: XYPosition }[] = []
  const unplaced = nodes.filter(node => !points.has(node.id))
  const placements = nodes.flatMap<N>(node => {
    const point = points.get(node.id)
    if (!point) return []
    const width = node.width ?? 166, height = node.height ?? 64
    let position = { x: point.x - width / 2, y: point.y + 14 }
    const overlaps = (at: XYPosition) => labels.some(label =>
      Math.abs(at.x + width / 2 - label.position.x - label.width / 2) < (width + label.width) / 2 + GUTTER &&
      Math.abs(at.y + height / 2 - label.position.y - label.height / 2) < (height + label.height) / 2 + GUTTER)
    for (let row = 0; overlaps(position); row++) {
      const offset = Math.floor(row / 2) * (height + GUTTER)
      position = { x: point.x - width / 2, y: row % 2 === 0 ? point.y - height - 14 - offset : point.y + 14 + offset + height + GUTTER }
    }
    labels.push({ position, width, height })
    marks.push({ id: node.id, point, label: { x: position.x + width / 2, y: position.y + (position.y < point.y ? height : 0) } })
    return [{ ...node, position, draggable: false, className: 'mesh-geographic-node' }]
  })
  const extent = labels.reduce((box, { position, width, height }) => ({
    left: Math.min(box.left, position.x),
    top: Math.min(box.top, position.y),
    right: Math.max(box.right, position.x + width),
    bottom: Math.max(box.bottom, position.y + height),
  }), { left: 0, top: 0, right: WORLD_WIDTH, bottom: WORLD_HEIGHT })
  const columns = narrow ? 3 : unplaced.length > 5 ? 2 : 1
  const tray: Rect | undefined = unplaced.length ? {
    x: narrow ? 0 : extent.right + 28,
    y: narrow ? extent.bottom + 30 : 0,
    width: narrow ? WORLD_WIDTH : columns * 200,
    height: TRAY_HEADER + Math.ceil(unplaced.length / columns) * ROW_HEIGHT,
  } : undefined
  if (tray) {
    for (const [index, node] of unplaced.entries()) {
      placements.push({ ...node, draggable: false, position: {
        x: tray.x + (index % columns + .5) * tray.width / columns - (node.width ?? 166) / 2,
        y: tray.y + TRAY_HEADER + Math.floor(index / columns) * ROW_HEIGHT,
      } })
    }
  }
  const bounds: Rect = {
    x: extent.left - GUTTER,
    y: extent.top - GUTTER,
    width: Math.max(extent.right, tray ? tray.x + tray.width : 0) - extent.left + GUTTER * 2,
    height: Math.max(extent.bottom, tray ? tray.y + tray.height : 0) - extent.top + GUTTER * 2,
  }
  return { placements, marks, unknown: unplaced.length, tray, bounds }
}

export function MeshGeography({ marks, unknown, tray, locations }: Pick<ReturnType<typeof placeGeographicNodes>, 'marks' | 'unknown' | 'tray'> & {
  locations: ReadonlyMap<string, { source: string }>
}) {
  return <ViewportPortal>
    <div className="mesh-geography" aria-hidden="true" style={{ width: WORLD_WIDTH }}>
      <MeshAtlas />
      {tray ? <div className="mesh-geography__tray" style={{ left: tray.x, top: tray.y, width: tray.width, height: tray.height }}>
        <strong>Location unknown</strong><span>{unknown}</span>
      </div> : null}
      <svg className="mesh-geography__marks" width={WORLD_WIDTH} height={WORLD_HEIGHT} overflow="visible">
        {marks.map(({ id, point, label }) => <g key={id} data-geographic-point={id} data-approximate={locations.get(id)?.source === 'public-egress' || undefined}>
          <line x1={point.x} y1={point.y} x2={label.x} y2={label.y} />
          <circle cx={point.x} cy={point.y} r="5" />
        </g>)}
      </svg>
    </div>
  </ViewportPortal>
}
