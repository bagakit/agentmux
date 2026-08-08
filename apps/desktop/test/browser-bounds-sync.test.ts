import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FOCUS_RING_WIDTH_PROPERTY,
  LatestBrowserBoundsSynchronizer,
  focusRingInsetOf,
  focusRingYieldOf,
  nativeBoundsClearOfFocusRing,
  regionAncestorOf,
  rendererCssBoundsToWindowDip
} from '../src/renderer/src/lib/browser-bounds-sync.js'
import { REGION_CLASS } from '../src/renderer/src/lib/region-focus.js'
import { normalizeBrowserBounds } from '../src/shared/browser-bounds.js'

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/**
 * 一个身上挂着指定计算样式的元素替身。
 *
 * `focusRingInsetOf` 走 `getComputedStyle(element)`，那是全局函数而不是元素方法，所以不能只捏元素——
 * 要在这一格里把它换掉。用 `vi.stubGlobal` 而不是直接赋值，收尾由 vitest 负责（`unstubAllGlobals`），
 * 不会漏到别的测试里。
 */
function withComputedStyle(style: Record<string, unknown>): Element {
  const element = { nodeType: 1 } as unknown as Element
  vi.stubGlobal('getComputedStyle', (target: unknown) => {
    expect(target, 'focusRingInsetOf 取的不是传进去的那个元素').toBe(element)
    return style
  })
  return element
}

afterEach(() => vi.unstubAllGlobals())

describe('native Browser bounds synchronization', () => {
  it.each([
    { zoomFactor: 1, expected: { x: 120, y: 50, width: 640, height: 480 } },
    { zoomFactor: 1.25, expected: { x: 150, y: 62.5, width: 800, height: 600 } },
    { zoomFactor: 0.8, expected: { x: 96, y: 40, width: 512, height: 384 } }
  ])('maps Renderer CSS pixels to window DIP at $zoomFactor zoom', ({ zoomFactor, expected }) => {
    expect(rendererCssBoundsToWindowDip(
      { x: 120, y: 50, width: 640, height: 480 },
      zoomFactor
    )).toEqual(expected)
  })

  it('submits live resize geometry instead of leaving a stale native viewport visible', async () => {
    const apply = vi.fn(async () => {})
    const sync = new LatestBrowserBoundsSynchronizer(apply, vi.fn())

    sync.observe({ x: 10.2, y: 20.6, width: 800.1, height: 500.8 })
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce())
    expect(apply).toHaveBeenCalledWith({ x: 10, y: 21, width: 800, height: 501 })
  })

  it('keeps one request in flight and collapses a resize burst to its latest value', async () => {
    const first = deferred()
    const apply = vi.fn()
      .mockImplementationOnce(async () => await first.promise)
      .mockResolvedValue(undefined)
    const sync = new LatestBrowserBoundsSynchronizer(apply, vi.fn())

    sync.observe({ x: 0, y: 40, width: 900, height: 600 })
    sync.observe({ x: 0, y: 40, width: 850, height: 550 })
    sync.observe({ x: 0, y: 40, width: 800, height: 500 })
    expect(apply).toHaveBeenCalledOnce()

    first.resolve()
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2))
    expect(apply).toHaveBeenLastCalledWith({ x: 0, y: 40, width: 800, height: 500 })
  })

  it('turns transient zero geometry into an immediate hide without reporting an error', async () => {
    const apply = vi.fn(async () => {})
    const reportError = vi.fn()
    const sync = new LatestBrowserBoundsSynchronizer(apply, reportError)

    sync.observe({ x: 0, y: 0, width: 0, height: 500 })
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(null))
    expect(reportError).not.toHaveBeenCalled()
  })
})

/**
 * 交出去的矩形**逐字节**等于共用判定的答案——这一侧的「壳有没有偷偷再动一手」（#712）。
 *
 * 为什么单独一族而不是靠上面那几条：上面每一条都自带一个手写的期望矩形，于是只钉住了被它挑到的那
 * 几个输入。真正发生过的绕法是在壳里**共用调用之后**再夹一次——`const M = Math` 加
 * `M.max(7, …)`——它对 `{800.1, 500.8}` 这种大矩形毫无影响，所以那几条一条都不红（实测：3 suite
 * 67 条全绿），而任何窄于 7px 的 Region 被静默拉宽。normalization 那份的结构层按 `Math.xxx()` 的
 * **形状**判，别名写法也逃得掉；它文件头此前声称「绕过它的写法…要么产出与共用判定不同的取值而被行为
 * 层抓住」——那句话在这一族存在之前是假的，因为当时没有任何行为断言驱动这个壳。
 *
 * 期望值取自 {@link normalizeBrowserBounds} 本身而不是写死的字面量，是刻意的：这一族要判的性质就是
 * 「壳交出去的 === 共用判定算出来的」，用同一个函数当参照，恒等关系才是被断言的东西。这不违反
 * 「期望值不能由被测对象算出」——被测对象是**壳**，参照物在另一个模块，而那个模块自己的取值正确性由
 * browser-bounds-normalization 那份用写死的字面量钉着。两份合起来才完整：这一族只管转发是否忠实。
 */
describe('接线层：壳交出去的就是共用判定的答案（#712）', () => {
  // 每个输入都挑成「随手补一道地板/取整就会被打破」的形状。窄边那两条是 #712 的靶子本身。
  const FORWARDED = [
    { why: '窄于常见地板值的宽（7px 之下）', bounds: { x: 4, y: 9, width: 3, height: 260 } },
    { why: '窄于常见地板值的高', bounds: { x: 4, y: 9, width: 260, height: 2 } },
    { why: '两边都窄', bounds: { x: 0, y: 0, width: 1, height: 1 } },
    { why: '负原点（唯一真正承重的那道钳位）', bounds: { x: -0.6, y: -5, width: 40, height: 40 } },
    { why: '亚像素需要取整', bounds: { x: 10.4, y: 20.6, width: 800.2, height: 500.8 } },
    { why: '不足 1 物理像素的宽——拒绝成 null', bounds: { x: 0, y: 0, width: 0.9, height: 500 } },
    { why: '非有限数——拒绝成 null', bounds: { x: 0, y: 0, width: Number.NaN, height: 10 } }
  ] as const

  it.each(FORWARDED)('$why', async ({ bounds }) => {
    const apply = vi.fn(async () => {})
    const sync = new LatestBrowserBoundsSynchronizer(apply, vi.fn())

    sync.observe({ ...bounds })
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce())
    expect(apply).toHaveBeenCalledWith(normalizeBrowserBounds(bounds))
  })

  it('判据没有落空——这一族里至少有一个输入的答案是「窄但可用」，否则全是 null 相等', () => {
    // 没有这一条，上面七条可以在「共用判定被改成恒 null 且壳也恒交 null」时全部通过：两边都是 null，
    // 恒等成立而产品彻底坏掉。这里要求参照物里真有非 null 的窄矩形，那才是 #712 的靶子形状。
    const narrow = FORWARDED
      .map(({ bounds }) => normalizeBrowserBounds(bounds))
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .filter((value) => value.width < 7 || value.height < 7)
    expect(narrow.length, '没有任何「窄到会被地板改写」的可用矩形，这一族抓不到 #712 那种重夹')
      .toBeGreaterThan(0)
  })
})

/**
 * 原生视图必须给 Region 的焦点框让出位置（#341）。
 *
 * browser 那格的内容是窗口级的原生 `WebContentsView`，合成在**全部** renderer 像素之上——`z-index`、
 * 覆盖层、outline 一概盖不过它。所以在这一格，「焦点框画在内容之上」这条路根本不存在，只能几何让位：
 * 把原生视图的矩形按焦点框宽度往里推。
 *
 * 用无头浏览器验不出来（那儿没有原生视图），所以判据落在几何上。
 */
describe('原生视图给焦点框让位（#341）', () => {
  // stage 顶沿在 Region 下方 38px 处——那是 browser 工具条那一行，由 renderer 自己画。
  const REGION = { x: 100, y: 200, width: 800, height: 600 }
  const STAGE = { x: 100, y: 238, width: 800, height: 562 }

  it('把贴着 Region 的三边推进来，而顶沿不动', () => {
    const bounds = nativeBoundsClearOfFocusRing(STAGE, REGION, 2)

    // 左、右、下三边贴着 Region，各让开 2px。
    expect(bounds.x, '左沿没有让开焦点框').toBe(102)
    expect(bounds.x + bounds.width, '右沿没有让开焦点框').toBe(898)
    expect(bounds.y + bounds.height, '下沿没有让开焦点框').toBe(798)
    // 顶沿本来就在 Region 下方 38px（工具条那一行）——对它内缩会在工具条与网页之间凿出一条空隙。
    // 这就是选**求交**而不是「对 stage 四边内缩」的原因，也是这条断言唯一在守的东西。
    expect(bounds.y, '顶沿被推动了——工具条与网页之间会出现一条空隙').toBe(238)
  })

  it('stage 满铺整个 Region 时四边都让开', () => {
    // 独立窗口/无工具条的形态：stage 与 Region 同框，四边都贴着，于是四边都要推。
    const bounds = nativeBoundsClearOfFocusRing(REGION, REGION, 2)
    expect(bounds).toEqual({ x: 102, y: 202, width: 796, height: 596 })
  })

  it('环宽为 0 时原样返回（读不出宽度就退回旧行为，不凭猜推网页）', () => {
    expect(nativeBoundsClearOfFocusRing(STAGE, REGION, 0)).toEqual(STAGE)
  })

  it('负环宽在唯一入口就被挡住，不靠下游第二次钳位', () => {
    // 这条原来断言 `nativeBoundsClearOfFocusRing(STAGE, REGION, -4)` 原样返回——那是在给一层
    // 永远轮不到的钳位背书（本仓 two-budgets-guard-one-thing：两个预算守同一件事，短的那个只
    // 贡献假阴性）。负数**只能**从 focusRingInsetOf 进来，而它自己就不产出负数，所以求交那侧
    // 根本收不到负数。判据因此落在真正承重的那一处：消毒在取值口。
    const negative = { getPropertyValue: () => '-4px' }
    expect(
      focusRingInsetOf(withComputedStyle(negative)),
      '取值口放行了负环宽——原生视图会被往外推，盖住 Region 之外的像素'
    ).toBe(0)
    // 而且那个 0 会一路让求交变成「不让位」，与读不出宽度时同一个保守行为。
    expect(nativeBoundsClearOfFocusRing(STAGE, REGION, focusRingInsetOf(withComputedStyle(negative)))).toEqual(STAGE)
  })

  it('环宽取自那个自定义属性，不是任何绘制属性', () => {
    // 焦点框的画法已经换过两次（inset 阴影 → outline → 定位覆盖层）。按绘制属性取值的那一侧，
    // 每次换法都会静默读到 0、原生视图回到满铺，而两侧测试各自全绿。所以取的必须是那个属性名。
    const element = {
      // 故意让每一个绘制属性都给出一个**不同且非零**的数：如果实现改回读其中任何一个，
      // 下面的断言会读到那个数而不是 6，当场变红。恒真的风险也一并排除（没有一个值等于 6）。
      outlineOffset: '-3px',
      outlineWidth: '4px',
      borderWidth: '5px',
      getPropertyValue: (property: string) =>
        property === FOCUS_RING_WIDTH_PROPERTY ? '6px' : ''
    }
    expect(focusRingInsetOf(withComputedStyle(element))).toBe(6)
  })

  it('那个属性没声明时返回 0，而不是 NaN 灌进 setBounds', () => {
    // 读不出数的两种现场：非浏览器环境，与该元素身上没有这个属性（比如祖先链断了）。
    // 返回 NaN 会让 normalizeBounds 把整个矩形判成不可用、原生视图直接消失——比"框被遮住"坏得多。
    expect(focusRingInsetOf(withComputedStyle({ getPropertyValue: () => '' }))).toBe(0)
    expect(focusRingInsetOf(withComputedStyle({ getPropertyValue: () => 'inherit' }))).toBe(0)
    expect(focusRingInsetOf(withComputedStyle({ getPropertyValue: () => '0px' }))).toBe(0)
  })

  /**
   * 让位量的**极性**：只有聚焦的那一格让，其余格不让（#350）。
   *
   * 这条是行为层，与下面那条接线层分开。原来的缺陷不在算得对不对，而在这个判定根本不存在：
   * BrowserPane 只问「有没有 `.workbench-region` 祖先」，而环宽那个自定义属性声明在 `:root`
   * （tokens.css），任何 Region 都继承得到一个正数——于是每一格都内缩 2px。未聚焦的 browser 区
   * 被推进来，露出底下 `.browser-stage` 的 `--surface-0`（#111419）：网页多为浅色时那是一条
   * 看得见的深边，而它没有对应的绿环。用户看到的是"没聚焦的那格镶了一圈黑边"。
   *
   * 两侧都要钉住：只钉「聚焦时要让」，写死成 `return focusRingInsetOf(element)` 就通过（正是缺陷
   * 原样）；只钉「未聚焦时是 0」，写死成 `return 0` 也通过（焦点框三边重新被物理遮掉，#341 回归）。
   */
  it('让位量只在聚焦那一格取环宽，未聚焦取 0', () => {
    const ringOf = (declared: string): Element =>
      withComputedStyle({
        getPropertyValue: (property: string) =>
          property === FOCUS_RING_WIDTH_PROPERTY ? declared : ''
      })

    // 聚焦：取得到环宽，且**取的就是那个属性的值**（不是某个手抄的常量——写死 2 恰好等于今天的
    // token，故这里用 5 让"手抄 2"当场红）。
    expect(focusRingYieldOf(ringOf('5px'), true), '聚焦的那一格没有让位，焦点框三边会被原生视图遮掉').toBe(5)
    // 未聚焦：即便这个元素身上读得出环宽（:root 继承，永远读得出），也必须是 0。
    expect(
      focusRingYieldOf(ringOf('5px'), false),
      '未聚焦的那一格也让位了——browser 区镶一圈无环的深边（#350 原样）'
    ).toBe(0)
    // 自检：这个判别器在场。如果 fixture 恰好读不出环宽，上面两条会都是 0 而"未聚焦"那条恒真。
    expect(focusRingInsetOf(ringOf('5px')), '判别器缺席：fixture 读不出环宽，上面那对断言无从分辨').toBe(5)
  })

  /**
   * 上面几条守的是**算得对**，这条守的是**有人在算**。
   *
   * 两层分开，因为它们各自能独立坏掉：把 `nativeBoundsClearOfFocusRing` 改错，上面的断言红；
   * 把它从 BrowserPane 的取值链上摘下来（`observe(stageBounds…)` 直接绕过），上面**一条都不红**——
   * 那些测试从不执行调用点。这是本仓反复中招的形状（extracting-to-lib-only-fixes-half：
   * 内容变可测了，而"壳有没有被执行到"照旧无人守）。
   *
   * 判据按 AST 落在「交给 observe 的那个值，是不是由这次求交算出来的」上，而不是「文件里有这个名字」：
   * 保留 import、把它算完丢掉、`observe` 仍传 stage 全尺寸——那种形状文本判据看不出来
   * （guard-criterion-must-be-import-relation）。
   */
  it('BrowserPane 真的把原生边界折过这次让位，而不是只 import 了它', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/components/BrowserPane.tsx', import.meta.url),
      'utf8'
    )
    const ast = ts.createSourceFile('BrowserPane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

    // 收集每一处 `synchronizer.observe(...)` 的实参文本。**必须限定接收者**：ResizeObserver 的
    // `observer.observe(stage)` 同名，只按方法名抽会把它一起卷进来（我第一版就这么错了，抽到 2 条）。
    const observed: string[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'observe' &&
        node.expression.expression.getText(ast) === 'synchronizer'
      ) {
        observed.push(node.arguments[0]?.getText(ast) ?? '')
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)

    // 自检：抽取器真的找到了调用点，否则下面按内容判的那条跑零次、恒绿。
    expect(
      observed.length,
      'observe 调用点抽取器一个都没找到——下面那条守卫是死代码（组件重构过？）'
    ).toBeGreaterThanOrEqual(2)

    // 隐藏那条路传 null 是对的（菜单开着、截图中、about:blank 等），不该被算成"没让位"。
    const geometry = observed.filter((argument) => argument !== 'null')
    expect(geometry.length, '没有任何一处 observe 传几何——原生视图永远不显示').toBe(1)

    // 传出去的那个几何值，必须是**这次让位算出来的东西**。写死成 stage 全尺寸（旧行为）时，
    // 那个标识符不会出现在从它到 observe 的赋值链上。
    const argument = geometry[0]!
    const carrier = /\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(argument)?.[1]
    expect(
      carrier,
      `observe 的几何实参是 \`${argument}\`，解析不出它交出去的是哪个变量`
    ).toBeTruthy()
    // 那个变量必须在某处被赋成 nativeBoundsClearOfFocusRing(...) 的结果。
    expect(
      new RegExp(`\\b${carrier}\\s*=\\s*nativeBoundsClearOfFocusRing\\(`).test(source),
      `交给 observe 的 \`${carrier}\` 从来没有被赋成 nativeBoundsClearOfFocusRing(...) 的结果——` +
        '原生视图铺满整格，Region 焦点框的左/右/下三边被物理遮掉（#341 的原样）'
    ).toBe(true)
    // 而且环宽必须是**取来的**而不是手抄的字面量：那条链断了的症状与没让位一样隐蔽。
    // 判据落在 `nativeBoundsClearOfFocusRing` 的第三个实参上——「文件里出现过这个名字」不够：
    // 算完丢掉、第三个实参仍写 `focusRingInsetOf(region)`（无条件让位，#350 原样）在文本上合法。
    const yieldCall = /nativeBoundsClearOfFocusRing\(([\s\S]*?)\n\s*\)/.exec(source)?.[1] ?? ''
    const yieldArgument = yieldCall.split('\n').at(-1)?.trim().replace(/,$/, '') ?? ''
    expect(
      yieldArgument,
      `让位量那个实参是 \`${yieldArgument}\`，不是 focusRingYieldOf(...)——` +
        '让位量要么变成手抄的数（改 CSS 时原生视图不跟着改），要么绕过"只有聚焦那格才让"这条极性判定'
    ).toMatch(/^focusRingYieldOf\(/)
    // 极性那个入参必须是**上游传下来的焦点结论**，不是这里自己判的。写成字面量 true 就是无条件
    // 让位（#350 原样）；写成 false 则焦点框三边重新被遮（#341 回归）。两者在类型上都合法。
    //
    // #545：焦点结论现在**从 ref 读**（`yieldToFocusRingRef.current`）而不是直接读 prop。理由是那条
    // 闪烁——把 prop 直接放进边界同步 effect 的依赖数组，焦点一变整条 effect 就拆了重建，cleanup 的
    // `setBounds(null)` 先藏后显，中间空一帧。读 ref 让边界计算永远拿到当前焦点值（不 stale），而
    // effect 不必订阅 prop。所以这里既接受直接读 prop、也接受读那个专门跟踪 prop 的 ref；把它写死成
    // true / false（绕过 props）仍然被下面的正则挡住。而“ref 是否真跟着 prop 走”由下一条断言钉住——
    // 只认 ref 而不校验它的赋值来源，等于给一个可能永远是初值的 ref 背书。
    expect(
      yieldArgument,
      `focusRingYieldOf 的第二个实参写死了：\`${yieldArgument}\`。焦点结论必须由 props 传进来` +
        '（regionFocusExpression 一次算出，与挂在 Region 上的类名共用那次比较）'
    ).toMatch(/focusRingYieldOf\([^,]+,\s*(yieldToFocusRing|yieldToFocusRingRef\.current)\s*\)/)
    // 若极性走的是 ref，那个 ref 必须在某处被赋成 prop 的当前值——否则它可能永远停在初值，
    // 焦点变化对它不可见（#341/#350 同时回归），而上面那条正则照旧命中。
    if (yieldArgument.includes('yieldToFocusRingRef.current')) {
      expect(
        /\byieldToFocusRingRef\.current\s*=\s*yieldToFocusRing\b/.test(source),
        '极性从 yieldToFocusRingRef.current 读，但没有任何一处把它赋成 yieldToFocusRing——' +
          'ref 会停在初值，焦点变化对边界计算不可见（#341/#350 回归），而上面那条正则仍绿'
      ).toBe(true)
    }
  })

  /**
   * 反查 Region 祖先用的那个选择器（#352 的 S3）。
   *
   * 这一条守的是**那个分支到底可不可达**。它原来内联在 BrowserPane 里，写成
   * `stage.closest('.workbench-region')`——那个字符串与 Region 元素实际带的类名分居两个文件、
   * 互相没有任何编译期联系。把它拼错一个字母（实测 `.workbench-regionX`）的后果是 `closest`
   * **恒返回 null**，于是整个 `if (region)` 分支变成死代码、原生视图回到满铺、焦点环的左/右/下
   * 三边被物理遮掉（#341 原样）——而 tsc exit 0，23 条全绿。上面那些接线守卫读源码文本判
   * 「求交算过了吗」，看不出那次求交在运行期一次都没执行（guard-must-check-reachability-not-presence）。
   *
   * 判据钉住**问出去的选择器**，并且期望值不由被测代码算出（expected-value-must-not-derive-from-mutation-target）：
   * 左边喂进 `closest` 的实参，右边是从 REGION_CLASS 拼出的选择器，而 REGION_CLASS 是挂类名那一侧
   * 用的同一个常量。所以「这个选择器选得到那个元素」这句话被两侧同源保证。
   */
  it('反查 Region 祖先用的选择器就是挂在 Region 上的那个类名', () => {
    const asked: string[] = []
    const region = { nodeType: 1 } as unknown as Element
    const stage = {
      nodeType: 1,
      closest: (selector: string): Element | null => {
        asked.push(selector)
        // 只有正确的选择器才认得出这个祖先——错一个字母就返回 null，正是那个变异的形状。
        return selector === `.${REGION_CLASS}` ? region : null
      }
    } as unknown as Element

    expect(
      regionAncestorOf(stage),
      `问出去的选择器是 ${JSON.stringify(asked)}，选不到 Region 祖先——` +
        '整个求交分支变成死代码，原生视图铺满整格，焦点环三边被物理遮掉（#341 原样）'
    ).toBe(region)
    // 自检：真的问过一次（一次都没问也会让上面在某些实现下"碰巧"通过）。
    expect(asked.length, 'regionAncestorOf 根本没调 closest').toBe(1)
    // 判别器在场：这个替身确实会对错的选择器返回 null，否则上面那条断言无从分辨。
    expect(stage.closest('.something-else'), '判别器缺席：替身对任何选择器都给出祖先').toBeNull()
  })

  it('没有 Region 祖先时如实返回 null，而不是编一个出来', () => {
    // 独立窗口/预览等形态：没有 Region 包着，让位量无从谈起，调用方按原样铺满。这条与上面那条
    // 分开，因为它们各自能坏：上面那条守"认得出祖先"，这条守"认不出时不撒谎"。
    const stage = { nodeType: 1, closest: () => null } as unknown as Element
    expect(regionAncestorOf(stage)).toBeNull()
  })

  /**
   * 上面那两条守的是 `regionAncestorOf` **自己**的行为。这一条守的是它到底有没有被用上。
   *
   * 抽出成函数只解决一半（extracting-to-lib-only-fixes-half）：把 BrowserPane 里的
   * `regionAncestorOf(stage)` 改回手抄的 `stage.closest('.workbench-regionX')`，上面两条照旧
   * 全绿——它们直接调那个函数，从不执行调用点。实测这个变异在 29 条里**一条都不红**，正是
   * 它要防的那个靶子（拼错选择器 → 分支死掉 → 焦点环三边被遮，#341 原样）。
   *
   * 判据的落点：**求交那两个调用真正吃进去的那个 Region 值，是不是这次共用反查算出来的**。
   * 不能写成"禁止 `.closest(` 出现在这个文件里"（forbidden-shape-guard-misfires）：那种禁令
   * 换个拼法（`stage.closest?.(…)`、先存进变量再调）就绕过，而且会误伤本文件其它合法的同形
   * 调用——BrowserPane 里的元素选择、上下文菜单都可能正当地用 closest 找别的祖先。
   * 也不能只判"文件里出现过 regionAncestorOf"：保留 import、算完丢掉、求交仍吃手抄的那个值，
   * 在文本上完全合法（guard-criterion-must-be-import-relation 的同族）。
   */
  it('求交吃进去的 Region 就是共用反查算出来的那个，不是另一处手抄的选择器', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/components/BrowserPane.tsx', import.meta.url),
      'utf8'
    )
    const ast = ts.createSourceFile('BrowserPane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

    // 左边：从 `regionAncestorOf(...)` 出发，**传递地**收集所有由它派生出的名字。求交吃的不是
    // 那个元素本身而是它的矩形（`region` → `regionRect` → 矩形字面量），所以只比对直接载体会
    // 误报——判据要跟着这条派生链走。
    //
    // 派生只沿**求值位**走，这一点是承重的：`found ? stage.closest('.workbench-regionX') : null`
    // 的值来自那次手抄的 closest，**不来自**条件里的 `found`。按文本判"提到了载体"会把这种
    // 洗钱形态算成合规（实测存活），所以这里按 AST 递归，条件位一概不算。
    const valueSourcesOf = (node: ts.Node): Set<string> => {
      if (ts.isIdentifier(node)) return new Set([node.text])
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
        return valueSourcesOf(node.expression)
      }
      if (ts.isCallExpression(node)) {
        // `x.foo()` 的值派生自接收者 x（`region.getBoundingClientRect()` 就是这一支）；
        // 裸函数调用记成 `名字()` 标记，让 `regionAncestorOf()` 能当种子。
        if (ts.isPropertyAccessExpression(node.expression)) return valueSourcesOf(node.expression.expression)
        if (ts.isIdentifier(node.expression)) return new Set([`${node.expression.text}()`])
        return new Set()
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        return valueSourcesOf(node.expression)
      }
      // 两个分支都是求值位；条件不是。
      if (ts.isConditionalExpression(node)) {
        return new Set([...valueSourcesOf(node.whenTrue), ...valueSourcesOf(node.whenFalse)])
      }
      if (
        ts.isBinaryExpression(node) &&
        [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
          .includes(node.operatorToken.kind)
      ) {
        return new Set([...valueSourcesOf(node.left), ...valueSourcesOf(node.right)])
      }
      if (ts.isObjectLiteralExpression(node)) {
        const sources = new Set<string>()
        for (const property of node.properties) {
          if (ts.isPropertyAssignment(property)) {
            for (const source of valueSourcesOf(property.initializer)) sources.add(source)
          }
        }
        return sources
      }
      return new Set()
    }

    const declarations: { name: string; sources: Set<string> }[] = []
    // 右边：`nativeBoundsClearOfFocusRing` 的第二实参与 `focusRingYieldOf` 的第一实参，
    // 也就是"当成 Region 用"的那两个取值位。两处都要问，因为它们能各自被换掉。
    const regionConsumers: { call: string; argument: string; sources: Set<string> }[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
        declarations.push({ name: node.name.text, sources: valueSourcesOf(node.initializer) })
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(ast)
        const position = callee === 'nativeBoundsClearOfFocusRing' ? 1 : callee === 'focusRingYieldOf' ? 0 : -1
        if (position >= 0) {
          const argument = node.arguments[position]
          regionConsumers.push({
            call: callee,
            argument: argument?.getText(ast) ?? '<缺失>',
            sources: argument ? valueSourcesOf(argument) : new Set()
          })
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)

    // 自检 1：反查真的被调用并且结果被留住了。零个意味着下面的比对无从进行（而不是"通过"）——
    // 手抄回 `stage.closest('.workbench-regionX')` 时正是这一条先红。
    const seeds = declarations.filter((declaration) => declaration.sources.has('regionAncestorOf()'))
    expect(
      seeds.map((seed) => seed.name),
      'BrowserPane 里没有任何变量接住 regionAncestorOf(...) 的结果——' +
        'Region 祖先要么没查，要么是另一处手抄的选择器查的（拼错即整个求交分支死掉，#341 原样）'
    ).toHaveLength(1)

    // 传递闭包：一个名字若其**求值来源**里有已知载体，它也是载体。
    const carriers = new Set(seeds.map((seed) => seed.name))
    for (let pass = 0; pass < declarations.length; pass += 1) {
      const before = carriers.size
      for (const declaration of declarations) {
        if (carriers.has(declaration.name)) continue
        if ([...declaration.sources].some((source) => carriers.has(source))) carriers.add(declaration.name)
      }
      if (carriers.size === before) break
    }

    // 自检 2：两个消费位都抽到了。少一个说明求交被改了形状，判据失去落点。
    expect(
      regionConsumers.map((consumer) => consumer.call).sort(),
      `把 Region 当参数吃进去的调用抽到 ${JSON.stringify(regionConsumers.map((c) => c.call))}，应恰好是那两处`
    ).toEqual(['focusRingYieldOf', 'nativeBoundsClearOfFocusRing'])

    // 自检 3：判别器在场——闭包不是"文件里每个变量"。stage 那条链（`stage` → `rect` →
    // `stageBounds`）与 Region 无关，必须落在闭包外，否则上面那条比对对任何实参恒真。
    expect(
      [...carriers],
      '载体闭包把 stage 的几何也算了进去——它对任何实参都会成立，这条守卫成了恒真'
    ).not.toContain('stageBounds')

    // 正题：那两处吃进去的值都必须落在这条派生链上。
    for (const consumer of regionConsumers) {
      expect(
        [...consumer.sources].some((source) => carriers.has(source)),
        `${consumer.call} 吃进去的 Region 是 \`${consumer.argument}\`（求值来源 ` +
          `${JSON.stringify([...consumer.sources])}），追不回 regionAncestorOf 的结果（载体链 ` +
          `${JSON.stringify([...carriers])}）——那条查找被另一处手抄的选择器取代了。拼错一个字母的` +
          '后果是 closest 恒返回 null、整个求交分支变成死代码、原生视图回到满铺、' +
          '焦点环左/右/下三边被物理遮掉（#341 原样）'
      ).toBe(true)
    }
  })

  /**
   * 焦点变化必须重跑边界计算，但**不能**靠把让位量塞进边界同步 effect 的依赖数组来做到（#545）。
   *
   * 历史：这条曾要求 `yieldToFocusRing` 出现在那条 useLayoutEffect 的依赖数组里，为的是让焦点变化
   * 触发重算（#352 的 S2）——那时它确实修好了 #341/#350。但那个做法本身就是 #545 那道闪烁：让位量
   * 在焦点切换时变化，effect 因此在每次切换时**拆了重建**，cleanup 那句 `setBounds(null)` 先把原生
   * 视图藏起来，重建那次 rAF 下一帧才重新显示，中间空一帧。修法是把两件正交的事拆成两条 effect：
   *   - 边界同步 effect（拥有 synchronizer / ResizeObserver / resize 监听）**不订阅** yieldToFocusRing，
   *     焦点值改从 ref 读，所以焦点切换不再拆它。
   *   - 一条**独立**的 effect 以 `[yieldToFocusRing]` 为依赖，翻转时更新 ref 并触发一次重算
   *     （复用还活着的 synchronizer，不拆不建）。
   *
   * 所以这条判据反过来钉两件事，缺一不可：
   *   1) 边界同步 effect 的依赖数组里**没有** yieldToFocusRing（有 = 闪烁回归，#545）。
   *   2) 存在另一条以 yieldToFocusRing 为依赖的 effect（无 = 焦点变化不重算，#341/#350 回归）——
   *      单靠 ResizeObserver 兜不住，因为焦点在两格间移动不改变任何尺寸，observer 不触发。
   *
   * 只钉 (1) 会放过「谁都不重算」（#341/#350 回归）；只钉 (2) 会放过「让位量又混回同步 effect」
   * （闪烁回归）。两条一起，才把「既要焦点跟随、又不要闪烁」这件事的两面都守住。
   */
  it('焦点让位量不在边界同步 effect 的依赖里，而由一条独立 effect 驱动重算（#545 不闪 & #341/#350 跟随）', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/components/BrowserPane.tsx', import.meta.url),
      'utf8'
    )
    const ast = ts.createSourceFile('BrowserPane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

    // 收集每一条 useLayoutEffect 的依赖数组文本；同时记住哪条是**边界同步那条**（体内出现 synchronizer）。
    const effects: { deps: string[]; ownsSynchronizer: boolean }[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect') {
        const body = node.arguments[0]?.getText(ast) ?? ''
        const deps = node.arguments[1]
        const list = deps && ts.isArrayLiteralExpression(deps)
          ? deps.elements.map((element) => element.getText(ast))
          // 依赖数组不见了（每次渲染都重跑）也要被看见，而不是被抽取器无声跳过。
          : [`<不是数组字面量: ${deps?.getText(ast) ?? '缺失'}>`]
        effects.push({ deps: list, ownsSynchronizer: /\bsynchronizer\b/.test(body) })
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)

    // 自检：边界同步 effect 恰好一条。零个说明它没了或改了形状（判据失去落点）；多个说明几何同步
    // 被拆成了几处，得有人重新想清楚哪条拥有 synchronizer。
    const synchronizerEffects = effects.filter((effect) => effect.ownsSynchronizer)
    expect(
      synchronizerEffects.length,
      `拥有 synchronizer 的 useLayoutEffect 抽到 ${synchronizerEffects.length} 条，应恰好 1 条`
    ).toBe(1)
    const boundsDeps = synchronizerEffects[0]!.deps
    expect(boundsDeps.length, '边界同步 effect 的依赖数组是空的——它只在挂载时跑一次，几何永不跟随').toBeGreaterThan(0)

    // (1) 让位量**不在**边界同步 effect 的依赖里：在，则焦点切换会拆它重建，藏一帧再显示（#545 闪烁）。
    expect(
      boundsDeps,
      '让位量又回到了边界同步 effect 的依赖数组里：焦点切换会拆掉并重建这条 effect，' +
        'cleanup 的 setBounds(null) 先藏后显，中间空一帧就是那道闪烁（#545 回归）'
    ).not.toContain('yieldToFocusRing')

    // (2) 存在一条**独立**的 effect 以让位量为依赖：它负责在焦点翻转时触发重算。没有它，焦点变化
    // 不改变任何尺寸、ResizeObserver 不触发，于是永不重算——焦点到达 browser 区不内缩（#341 回归）、
    // 离开不退回（#350 回归）。它不能就是边界同步那条（那条不订阅让位量），所以要求 ownsSynchronizer=false。
    const focusEffects = effects.filter(
      (effect) => !effect.ownsSynchronizer && effect.deps.includes('yieldToFocusRing')
    )
    expect(
      focusEffects.length,
      '没有任何一条独立 effect 以 yieldToFocusRing 为依赖：焦点变化不改变尺寸，ResizeObserver 不触发，' +
        '于是边界永不随焦点重算——焦点到达 browser 区不内缩（#341 回归），离开不退回（#350 回归）'
    ).toBeGreaterThanOrEqual(1)
  })

  /**
   * 那条焦点 effect 真的**做了重算**，不是一个空壳（#545 的补线）。
   *
   * 上一条只钉「有一条以 yieldToFocusRing 为依赖的 effect」；一个体内什么都不干、或只更新了 ref
   * 却不触发重算的 effect 也能骗过它——那样焦点变化时 ref 是新的、但没人拿它去 setBounds，
   * 界面依旧不跟随（#341/#350 回归）。本仓 desktop 无 DOM 环境、renderToStaticMarkup 不跑 effect，
   * 所以按 AST 判「那条 effect 体里既把 ref 更新成当前 prop、又调了重算入口」。
   */
  it('焦点 effect 既更新 ref 又触发一次重算（不是空壳）', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/components/BrowserPane.tsx', import.meta.url),
      'utf8'
    )
    const ast = ts.createSourceFile('BrowserPane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

    const bodies: string[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect') {
        const body = node.arguments[0]?.getText(ast) ?? ''
        const deps = node.arguments[1]
        const list = deps && ts.isArrayLiteralExpression(deps)
          ? deps.elements.map((element) => element.getText(ast))
          : []
        // 焦点那条：依赖含让位量、且不拥有 synchronizer（那条不订阅让位量）。
        if (list.includes('yieldToFocusRing') && !/\bsynchronizer\b/.test(body)) bodies.push(body)
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)

    expect(bodies.length, '找不到那条焦点 effect（判据失去落点）——上一条应已先红').toBe(1)
    const body = bodies[0]!
    // 把 ref 更新成**当前** prop：否则边界计算读到的焦点值永远停在初值（#341/#350 回归）。
    expect(
      /yieldToFocusRingRef\.current\s*=\s*yieldToFocusRing\b/.test(body),
      '焦点 effect 没有把 yieldToFocusRingRef.current 更新成当前 yieldToFocusRing——' +
        'ref 停在初值，焦点变化对边界计算不可见（#341/#350 回归）'
    ).toBe(true)
    // 触发一次重算：更新了 ref 却不重算，等于焦点变了但没人拿新值去 setBounds。
    expect(
      /recomputeBoundsRef\.current\??\.\(\)/.test(body),
      '焦点 effect 更新了 ref 却没触发重算——焦点变化时界面不跟随（#341/#350 回归）'
    ).toBe(true)

    // 重算入口是一根**两头**的线，上面只钉住了读的那头。写的那头（边界同步 effect 把 update
    // 挂上来）缺席时，ref 永远是 null，`?.()` 于是是一句永久的 no-op——焦点变化照旧不重算
    // （#341/#350 回归），而上面两条断言、以及那条「有一条独立 effect」的断言，全都照旧命中。
    // 实测：删掉 `recomputeBoundsRef.current = update` 这一行，本文件 20 条 + 让位那 10 条全绿。
    // 所以这里判「拥有 synchronizer 的那条 effect 里，把重算入口赋成了一个函数」。判在同一条
    // 测试里而不是新开一条：读与写是同一根线的两端，分开判会让人以为它们是两件可以各自成立的事。
    const synchronizerBodies: string[] = []
    const walkForProducer = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect') {
        const effectBody = node.arguments[0]?.getText(ast) ?? ''
        if (/\bsynchronizer\b/.test(effectBody)) synchronizerBodies.push(effectBody)
      }
      ts.forEachChild(node, walkForProducer)
    }
    walkForProducer(ast)
    expect(synchronizerBodies.length, '找不到边界同步那条 effect（判据失去落点）').toBe(1)
    expect(
      /recomputeBoundsRef\.current\s*=\s*(?!null\b)\w/.test(synchronizerBodies[0]!),
      '边界同步 effect 没有把重算入口挂上来（只赋 null 不算）——recomputeBoundsRef 永远是 null，' +
        '焦点 effect 那句 `?.()` 是永久 no-op，焦点变化不重算（#341/#350 回归）而所有断言照旧全绿'
    ).toBe(true)
  })

  /**
   * 那个 prop 真的被**传进去**了，不只是声明在那里（#350 的第二段接线）。
   *
   * `yieldToFocusRing` 有默认值 `false`，所以调用点整段漏掉它在类型上完全合法、tsc 全程沉默，而
   * 原生视图从此永不让位——焦点框的左/右/下三边重新被物理遮掉（#341 原样）。记忆
   * optional-prop-only-buys-silence 的同族：可选属性买到的只是关掉 tsc。
   *
   * 判据按 AST 落在「那个属性的值就是那次判定的字段」上，而不是「文件里出现过这个名字」：
   * `yieldToFocusRing={false}` 与 `yieldToFocusRing={undefined && ...}` 都带着这个名字。
   */
  it('WorkspaceWorkbench 真的把焦点结论传给 BrowserPane', () => {
    const path = new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url)
    const source = readFileSync(path, 'utf8')
    const ast = ts.createSourceFile('WorkspaceWorkbench.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

    const values: string[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'yieldToFocusRing') {
        values.push(node.initializer?.getText(ast) ?? '<无值>')
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)

    expect(
      values.length,
      'BrowserPane 那处根本没传 yieldToFocusRing——它有默认值 false，所以 tsc 沉默而原生视图永不让位' +
        '（焦点框三边重新被遮，#341 回归）'
    ).toBe(1)
    // 值必须是那次判定的字段。写死成 false（永不让位）或 true（无条件让位，#350 原样）都在这里红。
    expect(
      values[0],
      `传进去的是 \`${values[0]}\`，不是那次焦点判定的结果——焦点结论必须与 Region 的类名同源`
    ).toMatch(/^\{focus\.nativeViewYieldsToRing\}$/)
  })
})
