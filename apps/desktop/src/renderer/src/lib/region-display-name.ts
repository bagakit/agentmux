import type { SessionSnapshot } from '../../../shared/contracts'
import type { WorkbenchSurface } from './workbench-tabs'
import { assertUnreachableSurface } from './workbench-surface-kinds'

/** Region labels and sibling numbering share one derivation for the region switch menu. */

/**
 * 一格的**表面短名**：按种类给一个人能认出的名——文件名（basename）/ 会话 label（Agent 与终端都用
 * `session.label`，即 Provider·Workspace 那条兜底层，不是解析后的显示名；终端另有常量 "Terminal"）/
 * 浏览器标题，无标题时退回完整 URL / "New Tab"。这只是指认用的标签，不进任何寻址 key，所以不必是
 * SSOT 显示名链的产物；与 `tabSurfaceFallback` 取名口径一致即可。同名多格的区分（编号）不在这里，
 * 由 {@link regionDisplayNames} 统一做——它才看得见兄弟格。
 */
export function regionSurfaceLabel(
  surface: WorkbenchSurface,
  sessions: readonly SessionSnapshot[]
): string {
  switch (surface.kind) {
    case 'file':
      return surface.path.split('/').at(-1) ?? surface.path
    case 'launcher':
      return 'New Tab'
    case 'browser':
      if (surface.title && surface.title !== 'about:blank') return surface.title
      return surface.url === 'about:blank' ? 'New Tab' : surface.url
    case 'terminal':
      return 'Terminal'
    case 'agent': {
      const session = sessions.find((item) => item.id === surface.sessionId)
      return session?.label ?? surface.sessionId
    }
    default:
      return assertUnreachableSurface(surface)
  }
}

export type RegionDisplayName = { regionId: string; name: string }

/**
 * 一张 Tab 里**每一格**的最终显示名，按传入顺序（**必须是布局的视觉顺序**：左→右 / 上→下，由
 * `regionIds(tab.layout.root)` 给出，而非 `Object.values` 的插入序）。这是编号规则的唯一实现。
 *
 * 编号只加在**重名**上：唯一的标签保持裸名（一个终端就是 "Terminal"，不无谓地加「1」），重名的按出现
 * 次序编号（"Terminal 1" / "Terminal 2"）。编号覆盖全体、含每一格自己，所以同一格的编号与右键点了谁
 * 无关——这正是消费者能安全「挑出其中一格」的前提。
 */
export function regionDisplayNames(
  regions: ReadonlyArray<{ regionId: string; label: string }>
): RegionDisplayName[] {
  const labelTotals = new Map<string, number>()
  for (const region of regions) {
    labelTotals.set(region.label, (labelTotals.get(region.label) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  return regions.map((region) => {
    const ordinal = (seen.get(region.label) ?? 0) + 1
    seen.set(region.label, ordinal)
    const name =
      (labelTotals.get(region.label) ?? 0) > 1 ? `${region.label} ${ordinal}` : region.label
    return { regionId: region.regionId, name }
  })
}

