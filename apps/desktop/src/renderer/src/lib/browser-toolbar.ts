import type { AppConfig, BrowserToolbarConfig } from '../../../shared/contracts'

export const BROWSER_TOOLBAR_ITEM_ORDER = [
  'selectElement',
  'screenshot',
  'devTools',
  'viewport',
  'more'
] as const satisfies readonly (keyof BrowserToolbarConfig)[]

export type BrowserToolbarItem = (typeof BROWSER_TOOLBAR_ITEM_ORDER)[number]

/**
 * 「这张顺序表不多不少，恰好覆盖 `BrowserToolbarConfig` 的每一个可配置项」的双向 exactness 证明。
 *
 * 为什么 `as const satisfies readonly (keyof BrowserToolbarConfig)[]` 不够：`satisfies` 只证
 * **⊆**（表里每一项都是合法的 config 键），对 **⊇**（每个 config 键都在表里）一无所知。于是从表里删掉
 * 一项（`more` 从工具栏静默消失），或给 `BrowserToolbarConfig` 加一项而忘了补进表里（新工具永远画不出
 * 偏好开关、`SurfaceToolDock` 的 `.map` 与 dirty 判定都看不见它），两者都**编译通过、无一处报错**。这正是
 * 本仓被咬过多次的那一族：一张手抄清单只强制了集合相等的一个方向。
 *
 * 为什么不能指望现成的旁路守卫——这是实测过的，不是推理：
 *   - 只从表里删 `more`，`tsc` 确实红，但红在**兄弟** `BROWSER_TOOLBAR_ITEM_LABELS`（`Record<
 *     BrowserToolbarItem, string>`，TS2353「'more' 不存在于 Record<…> 中」），不是红在这张表上；
 *   - 给 union 加一项（如 `zoom`）而不动表，`tsc` 也红，但红在**下游**默认配置字面量
 *    （`config-store.ts` 的 `DEFAULT_CONFIG`、`api.ts` 的 mock，TS2741「缺少属性 'zoom'」），仍不是这张表。
 *   两者都是偶然的连带效应，会随重构漂移。决定性的一枪：把 `more` 从表里删掉、**同时**把它在
 *   `BROWSER_TOOLBAR_ITEM_LABELS` 里配对的那一行也删掉（这两者本就是成对维护的），`tsc` 干净退出（实测
 *   `TSC_EXIT=0`），工具栏少一项而没有任何编译错误、没有任何单测发红——因为唯一钉住表内容的运行时断言
 *  （`.toEqual([...])`）住在 `test/` 里，而 `apps/desktop/tsconfig.json` 的 `include` 只有 `src/**`，那条
 *   断言对类型检查完全不可见。
 *
 * 两个方向都要写：`BrowserToolbarItem ⊆ keyof BrowserToolbarConfig` 抓「表里写了个不存在的键」
 *（`satisfies` 也抓这一半），`keyof BrowserToolbarConfig ⊆ BrowserToolbarItem` 抓真正危险的那一半——
 * 「union 长了/表短了而对方没跟上」。任一半是 `never` 都不能赋给 `true` 的槽位，于是漂移是一处点名了是哪个
 * 方向失败的编译错误。形状与 `packages/core/src/workbench-layout-preset.ts` 的 `_presetTupleIsExactlyTheUnion`
 * 和 `workbench-tab-actions.ts` 的 `_labelTablesAreExactlyTheirUnions` 相同。
 *
 * 这道证明是**活的**而非自反死代码：`BrowserToolbarItem` 从本表派生（`[number]`），但另一侧
 * `keyof BrowserToolbarConfig` 独立写在 `apps/desktop/src/shared/contracts.ts` 里。两侧不同源，故
 * `A extends B` / `B extends A` 都不会退化成 `X extends X` 的恒真（记忆 surviving-mutation-may-be-dead-condition
 * 与 core 那份注释亲手写明的「union 不可从表派生」）。`void` 让它不至于读成死变量——本包 `noUnusedLocals`
 * 未开，一个没人读的类型级 helper 不会被标记，所以它是否真被执行**靠实测**：见上文那两枪的 `tsc` 输出。
 *
 * 刻意不做的事——不额外加运行时行为断言：
 *   1. 这道命题是纯类型级的（`keyof` 在运行时被擦除），没有对应的运行时可观测量去断言 ⊇ 那一半；
 *   2. 「每个成员在 DOM 里各有一个控件」这件事已被 `browser-toolbar.test.tsx` 覆盖——`BrowserPane` 的
 *      顺序用例断言 5 个 aria-label 都渲染，隐藏用例断言各自都能被配置掉；再加一条 presence 断言只会撞上
 *      本仓记过的「形状重复时 toContain 恒真」。
 * 声明盲点：本证明看不见 `BrowserPane` 是否真为每个成员渲染了控件——`BrowserPane` 用的是逐项硬编码的
 * 条件（`toolbar?.selectElement ?` …），不是遍历本表，故「成员在表里、但 BrowserPane 没有对应渲染分支」
 * 这种表↔DOM 漂移由上述 DOM 用例守，不由这道类型证明守。
 */
const _browserToolbarOrderIsExactlyTheConfigKeys: [
  BrowserToolbarItem extends keyof BrowserToolbarConfig ? true : never,
  keyof BrowserToolbarConfig extends BrowserToolbarItem ? true : never
] = [true, true]
void _browserToolbarOrderIsExactlyTheConfigKeys

export const BROWSER_TOOLBAR_ITEM_LABELS: Record<BrowserToolbarItem, string> = {
  selectElement: 'Select element',
  screenshot: 'Screenshot',
  devTools: 'DevTools',
  viewport: 'Viewport',
  more: 'More'
}

export function withBrowserToolbarItem(
  config: AppConfig,
  item: BrowserToolbarItem,
  visible: boolean
): AppConfig {
  return {
    ...config,
    browser: {
      toolbar: {
        ...config.browser.toolbar,
        [item]: visible
      }
    }
  }
}
