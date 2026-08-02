import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FOCUS_RING_WIDTH_PROPERTY,
  LatestBrowserBoundsSynchronizer,
  focusRingInsetOf,
  focusRingYieldOf,
  nativeBoundsClearOfFocusRing,
  rendererCssBoundsToWindowDip
} from '../src/renderer/src/lib/browser-bounds-sync.js'

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
    // 负数当 0：环宽的取值方向由 CSS 决定，这里不替它解释一个负宽度。
    expect(nativeBoundsClearOfFocusRing(STAGE, REGION, -4)).toEqual(STAGE)
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
    expect(
      yieldArgument,
      `focusRingYieldOf 的第二个实参写死了：\`${yieldArgument}\`。焦点结论必须由 props 传进来` +
        '（regionFocusExpression 一次算出，与挂在 Region 上的类名共用那次比较）'
    ).toMatch(/focusRingYieldOf\([^,]+,\s*yieldToFocusRing\s*\)/)
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
