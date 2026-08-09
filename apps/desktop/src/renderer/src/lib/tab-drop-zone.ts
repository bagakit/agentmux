// 移植自一个成熟的 tab-group drop-zone 实现；保留其经过验证的
// Center Merge 与四向 Edge Split 判定，删去 AgentMux 当前不需要的类型依赖。

export type TabDropZone = 'center' | 'left' | 'right' | 'up' | 'down'

/**
 * tab 条的高度：落点在这个带子里就不算边缘切分（拖到标签条上是「换 tab 顺序」，不是分屏）。
 *
 * 刻意**不导出**：唯一的消费者是同文件的 `resolvePaneColumnEdgeZone`，调用方要覆盖时传
 * `options.tabStripHeightPx`。这一类「只被自己文件用却导出着」是 lib-export-reachability 那道门
 * 按定义抓不到的——可达性不动点会（正确地）判它活着，因为它确实有消费者，只是消费者在同一个
 * 文件里。所以它靠的是这条注释与 review，不是守卫。
 */
const TAB_GROUP_TAB_STRIP_HEIGHT_PX = 36

type PaneRect = { left: number; top: number; width: number; height: number }

export function resolvePaneColumnEdgeZone(
  panelRect: PaneRect,
  point: { x: number; y: number },
  options?: { bodyRect?: PaneRect | null; tabStripHeightPx?: number }
): Exclude<TabDropZone, 'center'> | null {
  const localX = point.x - panelRect.left
  const tabStripHeight = options?.tabStripHeightPx ?? TAB_GROUP_TAB_STRIP_HEIGHT_PX
  const tabStripBottom = panelRect.top + tabStripHeight
  if (point.y < tabStripBottom) return null

  // A drag over the tab strip is always a reorder gesture, even when the tab happens
  // to sit near the pane's horizontal edge. Split requires an intentional drop into
  // the body edge, keeping ordinary tab sorting predictable.
  const horizontalEdge = panelRect.width * 0.16
  if (localX < horizontalEdge) return 'left'
  if (localX > panelRect.width - horizontalEdge) return 'right'

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
