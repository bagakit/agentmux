import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workbenchSource = readFileSync(
  new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url),
  'utf8'
)
const appSource = readFileSync(
  new URL('../src/renderer/src/App.tsx', import.meta.url),
  'utf8'
)

/**
 * 「弹窗经常被浏览器挡了」这条规则**接到产品上了没有**。
 *
 * 判定逻辑本身由 native-surface-overlay.test.tsx 用真 Radix 测行为；这里只守接线——那是零调用者
 * 检查的那一半：`observeOverlays` 全绿也可能一个调用点都没有，规则于是从不生效，而没有任何断言会红。
 *
 * 这个文件读源码，所以每条扫描都得先证扫到了东西：`indexOf` 取锚点取空了会切出空串，
 * 之后每条 `not.toContain` 恒真（记忆 indexof-anchor-gone-slices-to-empty-string）。
 */
describe('native Browser visibility during renderer overlays', () => {
  /**
   * 原生视图可见性的那条**唯一**表达式。
   *
   * 不抄整行字面量：抄整行会让每次合法增删一个条件都打红这一条（此前就是这么写的，加
   * portalOverlayCount 当场红），而它并不比逐条判据更强——一行字符串既证明不了某个条件真的在
   * 取值位，也说不出为什么每个条件非在不可。
   */
  function visibilityExpression(): string {
    const start = workbenchSource.indexOf('nativeSurfacesVisible={visible')
    expect(start, '找不到原生视图可见性表达式——这个文件守的东西已经不在这儿了').toBeGreaterThan(-1)
    const end = workbenchSource.indexOf('}\n', start)
    expect(end, '可见性表达式没有结尾——切出来的会是整个文件的尾巴').toBeGreaterThan(start)
    const expression = workbenchSource.slice(start, end)
    expect(expression.length, '切出来是空的——下面每条断言都没有对象').toBeGreaterThan(0)
    return expression
  }

  it('自证：可见性表达式确实切出来了，且只有一条', () => {
    const expression = visibilityExpression()
    expect(expression).toContain('nativeSurfacesVisible={visible')
    // 两条并存 = 两个事实源，其中一条会静默保旧（记忆 two-write-sites-need-one-projection）。
    const occurrences = workbenchSource.split('nativeSurfacesVisible={visible').length - 1
    expect(occurrences, '原生视图可见性被算了不止一次——哪一条生效取决于渲染路径').toBe(1)
  })

  it('浮层开着时压低可见性——这是缺陷本身那一条', () => {
    // portalOverlayCount 是覆盖全仓浮层的那条协议判据。删掉它，被 Radix portal 出去的浮层
    // （21 个 Root 里没手动接线的那 18 个）又会被原生视图盖住。
    expect(visibilityExpression()).toContain('portalOverlayCount === 0')
  })

  it('手动租约仍在同一条表达式里——它守的是 portal 协议覆盖不到的那些', () => {
    // 两把租约不能合并：观察器写的是**绝对值**，手动租约是增量 acquire/release。合成一个字段，
    // 观察器每次写入都会把手动租约抹掉。AgentAvatar 的浮层 portal 出去时不带 data-state，
    // 协议判据看不见它——它必须继续自己持租约。
    expect(visibilityExpression()).toContain('nativeSurfaceOverlayCount === 0')
  })

  it('两个计数取自 store，不是组件本地状态', () => {
    // 本地状态只对这一棵子树成立，而浮层可以从任何地方打开。
    expect(workbenchSource).toContain('useAppStore((state) => state.portalOverlayCount)')
    expect(workbenchSource).toContain('useAppStore((state) => state.nativeSurfaceOverlayCount)')
  })

  it('观察器被订阅了——规则接到产品上，不是只有实现', () => {
    // 零调用者检查：observeOverlays 的测试全绿也可能一个调用点都没有。
    expect(appSource).toContain('observeOverlays(document.body, setPortalOverlayCount, MutationObserver)')
    expect(appSource).toContain("from './lib/native-surface-overlay'")
  })

  it('订阅点只有一处——两个观察器会互相覆盖计数', () => {
    const subscriptions = appSource.split('observeOverlays(').length - 1
    expect(subscriptions, 'observeOverlays 被订阅了不止一次——两个观察器写同一个字段').toBe(1)
  })
})
