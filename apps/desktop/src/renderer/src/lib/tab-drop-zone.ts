// 直接移植自 Orca components/tab-group/tab-drop-zone.ts；保留其经过验证的
// Center Merge 与四向 Edge Split 判定，删去 AgentMux 当前不需要的类型依赖。

export type TabDropZone = 'center' | 'left' | 'right' | 'up' | 'down'

export const TAB_GROUP_TAB_STRIP_HEIGHT_PX = 36

type PaneRect = { left: number; top: number; width: number; height: number }

export function resolvePaneColumnEdgeZone(
  panelRect: PaneRect,
  point: { x: number; y: number },
  options?: { bodyRect?: PaneRect | null; tabStripHeightPx?: number }
): Exclude<TabDropZone, 'center'> | null {
  const localX = point.x - panelRect.left
  const horizontalEdge = panelRect.width * 0.2
  if (localX < horizontalEdge) return 'left'
  if (localX > panelRect.width - horizontalEdge) return 'right'

  const tabStripHeight = options?.tabStripHeightPx ?? TAB_GROUP_TAB_STRIP_HEIGHT_PX
  const tabStripBottom = panelRect.top + tabStripHeight
  if (point.y < tabStripBottom) return null

  const bodyRect =
    options?.bodyRect ?? {
      left: panelRect.left,
      top: tabStripBottom,
      width: panelRect.width,
      height: Math.max(0, panelRect.height - tabStripHeight)
    }
  if (bodyRect.height <= 0) return null
  const bodyLocalY = point.y - bodyRect.top
  const verticalEdge = bodyRect.height * 0.2
  if (bodyLocalY < verticalEdge) return 'up'
  if (bodyLocalY > bodyRect.height - verticalEdge) return 'down'
  return null
}
