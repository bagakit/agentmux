import type { CollaborationArea, CollaborationRelation } from './agent-collaboration'
import { collaborationAgentNode, collaborationAreaNode } from './collaboration-presentation'

export const COLLABORATION_CARD = { width: 250, height: 94 } as const
const AREA_WIDTH = 586, AREA_STEP = 630, CARD_STEP_X = 300, CARD_STEP_Y = 108
const kinds = ['communication', 'creation', 'supervision'] as const
export type CollaborationSide = 'left' | 'right'
export type CollaborationBox = {
  id: string; areaId: string; kind: 'area' | 'agent'; column: number; cardColumn: number
  x: number; y: number; width: number; height: number; folded: boolean
}
export type CollaborationPoint = { x: number; y: number }

/** Layout reserves empty streets; a route never searches unrelated cards. */
export function collaborationGeometry(areas: readonly CollaborationArea[], folded: ReadonlySet<string>) {
  const boxes = new Map<string, CollaborationBox>(), heights = [0, 0]
  for (const [index, area] of areas.entries()) {
    const column = index % 2, x = column * AREA_STEP, y = heights[column]!
    const expanded = 56 + Math.max(1, Math.ceil(area.members.length / 2)) * CARD_STEP_Y
    heights[column] = y + expanded + 46
    const collapsed = folded.has(area.id), id = collaborationAreaNode(area.id)
    boxes.set(id, { id, areaId: area.id, kind: 'area', column, cardColumn: -1, x, y, width: AREA_WIDTH, height: collapsed ? 48 : expanded, folded: collapsed })
    if (collapsed) continue
    for (const [slot, member] of area.members.entries()) {
      const id = collaborationAgentNode(area.id, member), cardColumn = slot % 2
      boxes.set(id, { id, areaId: area.id, kind: 'agent', column, cardColumn,
        x: x + 18 + cardColumn * CARD_STEP_X, y: y + 44 + Math.floor(slot / 2) * CARD_STEP_Y,
        ...COLLABORATION_CARD, folded: false })
    }
  }
  return boxes
}

export function createCollaborationGeometrySelector() {
  let previousAreas: readonly CollaborationArea[] = [], previousFolded: ReadonlySet<string> = new Set()
  let boxes = new Map<string, CollaborationBox>()
  return (areas: readonly CollaborationArea[], folded: ReadonlySet<string>) => {
    const unchanged = areas.length === previousAreas.length && areas.every((area, index) => {
      const previous = previousAreas[index]!
      return area.id === previous.id && area.members.length === previous.members.length && area.members.every((member, at) => member === previous.members[at])
    }) && folded.size === previousFolded.size && [...folded].every(id => previousFolded.has(id))
    if (unchanged) return boxes
    boxes = collaborationGeometry(areas, folded); previousAreas = areas; previousFolded = folded
    return boxes
  }
}

export function collaborationPort(kind: CollaborationRelation['kind'], direction: 'in' | 'out', side: CollaborationSide) {
  return `${kind}-${direction}-${side}`
}
export function collaborationPortY(height: number, kind: CollaborationRelation['kind'], direction: 'in' | 'out') {
  return (kinds.indexOf(kind) * 2 + (direction === 'out' ? .5 : 1.5)) / 6 * height
}
export function collaborationPortPoint(box: CollaborationBox, kind: CollaborationRelation['kind'], direction: 'in' | 'out', side: CollaborationSide): CollaborationPoint {
  return { x: box.x + (side === 'left' ? 0 : box.width), y: box.y + collaborationPortY(box.height, kind, direction) }
}
export function collaborationInnerX(box: CollaborationBox) { return box.column * AREA_STEP + 293 }
