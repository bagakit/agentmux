import type { BrowserBounds } from '../../../shared/contracts'
import { REGION_CLASS } from './region-focus'

/**
 * 这个 stage 所在的 Region 容器（没有就是 null，比如独立窗口形态）。
 *
 * 为什么这一行值得单独成一个函数：它原来是 BrowserPane 里内联的 `stage.closest('.workbench-region')`，
 * 那个字符串与 Region 元素实际带的类名分居两个文件、互相无编译期联系。拼错一个字母的后果是
 * `closest` **恒返回 null** → 下游整个 `if (region)` 分支变成死代码 → 原生视图回到满铺 → 焦点环的
 * 左/右/下三边被物理遮掉（#341 原样）。而 tsc 沉默、既有守卫全绿：它们读源码文本判「求交算过了吗」，
 * 看不出那次求交在运行期一次都没执行。
 *
 * 收成函数买到两件事：选择器由 {@link REGION_CLASS} 拼出（与挂类名的那一侧同源，拼错它会同时打掉
 * CSS 规则查找），以及**「问出去的选择器是什么」变成运行期可观测的** —— 测试喂一个记录 `closest`
 * 实参的元素即可质询，不必再靠读源码猜。
 */
export function regionAncestorOf(stage: Element): Element | null {
  return stage.closest(`.${REGION_CLASS}`)
}

/** Converts zoomed Renderer CSS geometry into BrowserWindow content-view DIP. */
export function rendererCssBoundsToWindowDip(
  bounds: BrowserBounds,
  zoomFactor: number
): BrowserBounds {
  return {
    x: bounds.x * zoomFactor,
    y: bounds.y * zoomFactor,
    width: bounds.width * zoomFactor,
    height: bounds.height * zoomFactor
  }
}

/**
 * 原生 Browser 视图必须让开 Region 的焦点框。
 *
 * 焦点框（`.workbench-region--active::after` 那层覆盖层）画在 Renderer 的合成树里，而 Browser 那格的
 * 内容是一个**窗口级的原生视图**——它不在页面的层叠上下文里，画在整张页面之上，`z-index` / `outline` /
 * 覆盖层一概盖不过它。所以「把焦点框画在内容之上」这条路对这一格根本不存在：browser-stage 满宽到底，
 * 原生视图铺满它，于是焦点框的左、右、下三边被物理遮掉，只剩顶边那 2px 露在 38px 工具条那一行里。
 * 用户在分屏里点到 browser 那格，看到的是一条孤零零的上边线。
 *
 * 修法只能是几何让位：把原生视图的矩形与「Region 矩形按环内边界内缩后」的矩形求交。求交而不是直接
 * 对 stage 四边内缩——stage 的上沿本来就在 Region 下方 38px 处（工具条那一行），对它内缩会在工具条与
 * 网页之间凿出一条 2px 的空隙；求交则让上沿保持不动，只有真正贴着 Region 边的三边被推进来。
 *
 * `ringInset` 取自 CSS 的**计算值**而不是在这里手抄一个 2：这个数的 SSOT 是 tokens.css 的
 * `--region-focus-ring-width`。而且必须取那个自定义属性、**不能**取 `outline-offset` 或 `border-width`
 * 这类由当前绘制机制决定的属性——焦点框的画法已经换过两次（inset 阴影 → outline → 定位覆盖层，
 * 每次都是因为前一种被定位不透明子元素盖住），而每次换法都会让「按绘制属性取值」的这一侧静默读到 0、
 * 原生视图回到满铺，同时两侧测试各自全绿。取值方式必须与绘制方式解耦。
 */
export function nativeBoundsClearOfFocusRing(
  stage: BrowserBounds,
  region: BrowserBounds,
  ringInset: number
): BrowserBounds {
  // 这里**不再**做 `Math.max(0, ringInset)`：负数在唯一的入口就被挡住了（`focusRingInsetOf` 的
  // `width <= 0` 返回 0），所以那道钳位是第二层守同一件事的预算，永远轮不到它生效。本仓
  // two-budgets-guard-one-thing 的教训是这种叠层只贡献假阴性：读代码的人以为「负数在这里被处理了」，
  // 于是不会去问上游到底有没有消毒；而它一次都没执行过，也没有任何测试能让它独立变红。
  // 消毒收在取值那一处，这里如实使用传进来的数。
  const left = Math.max(stage.x, region.x + ringInset)
  const top = Math.max(stage.y, region.y + ringInset)
  const right = Math.min(stage.x + stage.width, region.x + region.width - ringInset)
  const bottom = Math.min(stage.y + stage.height, region.y + region.height - ringInset)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 焦点框宽度那个自定义属性的名字。改名时这里与 tokens.css 必须一起改，故有守卫钉住。 */
export const FOCUS_RING_WIDTH_PROPERTY = '--region-focus-ring-width'

/**
 * 焦点框占据 Region 内容边缘多宽，取自那个元素身上 CSS 的计算值。
 *
 * 读自定义属性而不是任何绘制属性，理由见 {@link nativeBoundsClearOfFocusRing}。读不出数
 * （非浏览器环境、或该属性没声明）时返回 0：宁可退回「原生视图铺满、焦点框被遮」这个旧行为，
 * 也不要凭猜一个数把网页往里推。
 */
export function focusRingInsetOf(element: Element): number {
  const declared = getComputedStyle(element).getPropertyValue(FOCUS_RING_WIDTH_PROPERTY)
  const width = Number.parseFloat(declared)
  if (!Number.isFinite(width) || width <= 0) return 0
  return width
}

/**
 * 这一格实际要让出多少：**只有聚焦的那一格**才有环要让，其余格是 0。
 *
 * 为什么这一步必须存在，而不是让调用方直接 `focused ? focusRingInsetOf(el) : 0`：`focusRingInsetOf`
 * 读的那个自定义属性声明在 `:root`（tokens.css），于是**任何** Region 元素都继承得到一个正数。所以
 * 「这个元素身上读得出环宽吗」不是「这一格聚焦吗」的代理——原来 BrowserPane 只问「有没有
 * `.workbench-region` 祖先」，等于无条件内缩：未聚焦的 browser 区也被推进来 2px，露出底下
 * `.browser-stage` 的 `--surface-0`（#111419）。网页多为浅色时那就是一圈看得见的深边，而它没有对应的
 * 绿环——用户看到的是「没聚焦的那格镶了一圈黑边」（#350）。
 *
 * 聚焦与否由 `regionFocusExpression` 一次算出（类名与这个让位量共用那一次比较），这里只消费它的结论。
 */
export function focusRingYieldOf(element: Element, focused: boolean): number {
  if (!focused) return 0
  return focusRingInsetOf(element)
}

function normalizeBounds(bounds: BrowserBounds | null): BrowserBounds | null {
  if (!bounds) return null
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (values.some((value) => !Number.isFinite(value)) || bounds.width < 1 || bounds.height < 1) {
    return null
  }
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  }
}

function sameBounds(left: BrowserBounds | null | undefined, right: BrowserBounds | null): boolean {
  if (left === undefined) return false
  if (left === null || right === null) return left === right
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

/** Owns the Renderer-to-Main geometry hot path for one native Browser surface. */
export class LatestBrowserBoundsSynchronizer {
  private disposed = false
  private draining = false
  private pending: BrowserBounds | null | undefined
  private applied: BrowserBounds | null | undefined

  constructor(
    private readonly apply: (bounds: BrowserBounds | null) => Promise<void>,
    private readonly onError: (error: unknown) => void
  ) {}

  observe(bounds: BrowserBounds | null): void {
    if (this.disposed) return
    this.pending = normalizeBounds(bounds)
    void this.drain()
  }

  dispose(): void {
    this.disposed = true
    this.pending = undefined
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return
    this.draining = true
    try {
      while (!this.disposed && this.pending !== undefined) {
        const next = this.pending
        this.pending = undefined
        if (sameBounds(this.applied, next)) continue
        await this.apply(next)
        this.applied = next
      }
    } catch (error) {
      if (!this.disposed) this.onError(error)
    } finally {
      this.draining = false
      if (!this.disposed && this.pending !== undefined) void this.drain()
    }
  }
}
