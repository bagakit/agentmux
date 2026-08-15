import type { SessionSnapshot } from '../../../shared/contracts'
import type { WorkbenchSurface } from './workbench-tabs'
import { assertUnreachableSurface } from './workbench-surface-kinds'

/**
 * 「这一格叫什么」——一个 Region 显示名的**唯一**派生处。
 *
 * 一个 Tab 有真名字段（`WorkbenchTab.name`，含改名交互）；一个 Region 没有任何名字字段——布局叶子的
 * 载荷就是 `{ regionId }`。它唯一能给人看的名，全靠这里现算。此前这份逻辑劈成两半散在两个文件里
 * （表面→短名在 WorkspaceWorkbench，重名编号在 regionSwapMenuEntries），只为喂换位子菜单。第二个
 * 消费者（composer 里的 Region 名水印）即将出现；它若照抄这份逻辑，就是本仓 duplicated-rule-defeats-
 * the-fix 那一族：两份拼法今天一致、日后静默分家，各自被自己的测试守着、双双全绿。收成这一处即两个
 * 消费者共用同一次派生，不存在第二份可漂移。
 */

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

/**
 * 单独一格的显示名——但它**要求整套兄弟格**作为入参，因为名字取决于兄弟：「Terminal」只有在另一格也叫
 * 「Terminal」时才变成「Terminal 2」。故这里没有、也不提供一个「只看单格就返回名字」的重载：那种签名
 * 必然是错的（它看不见让自己变成 "Terminal 2" 的那个兄弟）。取不到该格返回 undefined。
 *
 * 水印消费者用这一支：给它这张 Tab 的全体 regions（视觉顺序）与要显示的那一格 id。
 */
export function regionDisplayName(
  regions: ReadonlyArray<{ regionId: string; label: string }>,
  regionId: string
): string | undefined {
  return regionDisplayNames(regions).find((region) => region.regionId === regionId)?.name
}
