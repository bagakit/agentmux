import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { allStyles } from './helpers/styles.js'
import {
  PANE_GROUP_FOCUS_CLASS,
  REGION_FOCUS_CLASS,
  focusRingExpressesChoice,
  paneGroupFocusClass,
  regionFocusExpression
} from '../src/renderer/src/lib/region-focus.js'

/**
 * 「多个 Region 时，当前聚焦在哪一格」必须看得出来（#339，用户原话：「多个 region, 当前聚焦在哪里,
 * 看不出俩」）。
 *
 * 这条守的不是某一个 CSS 声明长什么样——那是设计的自由。守的是这件事**有没有人在负责**：
 *   1. 组件真的按 `activeRegionId` 分岔，而不是给每一格同一个类名（取值层）
 *   2. 那个类名真的对应到有实际视觉效果的声明，而不是一条空规则（表达层）
 *   3. 焦点与非焦点在**同一个属性**上取不同值，否则"有声明"也可能是两边都一样（差别层）
 *
 * 为什么第 2、3 条要分开：本仓 #111 的先例是「CSS 守卫只查选择器名存在，删掉承重声明体全绿」。
 * 只判 `.workbench-region--active` 这个选择器在不在，把它的 body 清空即可绕过——屏幕上焦点
 * 彻底消失，而守卫沉默。反过来只判「body 非空」也不够：写一条与默认态**取值相同**的声明
 * （比如都是 transparent）同样让焦点不可见。
 *
 * 键盘那一侧已经在场且可达（`lib/workbench-shortcuts.ts:268` 的 `focus-region.{left,right,up,down}`
 * 走 `store.focusRegion`），所以用户能把焦点切到看不见的地方——这正是"看不出来"最难受的现场：
 * 按了键，界面上没有任何东西变。
 */

const WORKBENCH_TSX = new URL(
  '../src/renderer/src/components/WorkspaceWorkbench.tsx',
  import.meta.url
)

/** 注释里描述规则的文字不是规则本身（与 surface-selection-contract 同一条处理）。 */
const styles = allStyles().replace(/\/\*[\s\S]*?\*\//g, '')

type Rule = { selector: string; body: string }

function rules(): Rule[] {
  const out: Rule[] = []
  for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim().replace(/\s+/g, ' ')
    if (selector.startsWith('@')) continue
    out.push({ selector, body: match[2]! })
  }
  return out
}

/** 一条规则里声明的属性 → 取值。同一属性重复声明时后者胜（层叠内规则内的顺序）。 */
function declarations(rule: Rule): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of rule.body.split(';')) {
    const at = part.indexOf(':')
    if (at < 0) continue
    const property = part.slice(0, at).trim()
    if (!property) continue
    out.set(property, part.slice(at + 1).trim())
  }
  return out
}

/**
 * 某个类名恰好命中的规则们（不含把它当祖先或兄弟的选择器）。
 *
 * 用词法边界收紧：`.workbench-region` 是 `.workbench-region--active` 与
 * `.workbench-region-split` 的前缀，`includes` 会把三者混成一堆，于是"默认态"里混进焦点态的
 * 声明，第 3 条差别断言当场退化成恒真（记忆 counting-a-symbol-misses-other-spellings 的同族：
 * 判据比它要防的拼法更粗）。
 */
function rulesForClass(className: string): Rule[] {
  const exact = new RegExp(`\\.${className}(?![\\w-])`)
  return rules().filter((rule) =>
    rule.selector.split(',').some((part) => exact.test(part.trim()))
  )
}

/**
 * 焦点判定所在的那个模块。类名与「原生视图要不要让位」由它一次算出（#350），所以「按 activeRegionId
 * 分岔」这件事的判据也跟着落到这里——它原来在 WorkspaceWorkbench 的一个内联三元里。
 */
const REGION_FOCUS_TS = new URL('../src/renderer/src/lib/region-focus.ts', import.meta.url)

/**
 * 焦点判定里那个分岔的两个分支。
 *
 * 按 AST 取而不是 grep：判据要落在「这个三元的两个分支给出**不同**的类名」上。
 * 文本判据看不出 `? REGION_FOCUS_CLASS : REGION_FOCUS_CLASS` 与 `? '' : ''` 这两种把分岔抹平的
 * 写法（前者每格都亮，后者每格都不亮，用户看到的都是"分不出焦点"）。
 *
 * 条件里认 `focused` 这个名字之外还认 `activeRegionId`：判定收进纯函数后条件是那个入参算出的
 * 布尔，直接写 `activeRegionId === regionId` 也合法，两种写法都该被取到。
 */
function activeRegionConditional(): { whenActive: string; whenNot: string } | null {
  const text = readFileSync(REGION_FOCUS_TS, 'utf8')
  const source = ts.createSourceFile(
    'region-focus.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  let found: { whenActive: string; whenNot: string } | null = null
  const walk = (node: ts.Node): void => {
    if (
      ts.isConditionalExpression(node) &&
      /\b(?:focused|activeRegionId)\b/.test(node.condition.getText(source))
    ) {
      found = {
        whenActive: node.whenTrue.getText(source),
        whenNot: node.whenFalse.getText(source)
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return found
}

/** 某个焦点类名的伪元素覆盖层规则。三条断言共用一处，免得各写一遍正则再各自漂。 */
function focusOverlayRules(className: string): Rule[] {
  const overlay = new RegExp(`\\.${className}\\b[^,]*::(?:after|before)`)
  return rules().filter((rule) => rule.selector.split(',').some((part) => overlay.test(part.trim())))
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const
type Side = typeof SIDES[number]
const BORDER_STYLES = new Set([
  'none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'
])

/** 样式里每个自定义属性的全部声明（明暗两套主题会各声明一次，所以是列表不是单值）。 */
function tokenDefinitions(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const match of styles.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    const list = out.get(match[1]!) ?? []
    list.push(match[2]!.trim())
    out.set(match[1]!, list)
  }
  return out
}
const TOKENS = tokenDefinitions()

/**
 * 把 `var(--x)` 展开成它声明过的取值们。
 *
 * 必须展开才判得动：`transparent` 可以藏在一个 token 后面，而「边色是不是 var(...)」这种表层判据
 * 对它完全失明。展不开（该 token 没声明）时原样返回，由 {@link focusRingFaults} 报成另一条故障——
 * 那正是 injected-css-property-declare-default 那一族。
 *
 * `tokens` 是入参而不是直接读模块级的那张表：自检要能构造「透明藏在 token 后」这种样本，而它需要
 * 一个真样式表里不存在的 token。写成入参之后，自检喂什么就判什么，不必往产品样式里塞探针。
 */
function resolvedValues(value: string, tokens: Map<string, string[]>, depth = 0): string[] {
  const match = /var\(\s*(--[\w-]+)\s*\)/.exec(value)
  if (!match || depth > 4) return [value.trim()]
  const definitions = tokens.get(match[1]!)
  if (!definitions?.length) return [value.trim()]
  const head = value.slice(0, match.index)
  const tail = value.slice(match.index + match[0].length)
  return definitions.flatMap((definition) => resolvedValues(head + definition + tail, tokens, depth + 1))
}

/** 按空白切分，但不切进 `var(...)` 里面。 */
function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (depth === 0 && /\s/.test(char)) {
      if (current) parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) parts.push(current)
  return parts
}

function looksLikeLength(text: string): boolean {
  const value = text.trim().toLowerCase()
  return /^-?(?:\d*\.)?\d+(?:px|em|rem|pt|%|vh|vw)?$/.test(value) || ['thin', 'medium', 'thick'].includes(value)
}
function isWidthPart(part: string, tokens: Map<string, string[]>): boolean {
  return resolvedValues(part, tokens).every(looksLikeLength)
}
function isZeroWidth(part: string, tokens: Map<string, string[]>): boolean {
  return resolvedValues(part, tokens).some((value) => /^-?0(?:\.0+)?(?:px|em|rem|pt|%)?$/.test(value.trim()))
}
function isInvisibleColor(part: string, tokens: Map<string, string[]>): boolean {
  return resolvedValues(part, tokens).some((raw) => {
    const value = raw.trim().toLowerCase()
    return (
      value === '' ||
      value === 'transparent' ||
      value === 'none' ||
      /^rgba?\([^)]*[,/]\s*0(?:\.0+)?\s*\)$/.test(value) ||
      /^#[0-9a-f]{6}00$/.test(value) ||
      /^#[0-9a-f]{3}0$/.test(value)
    )
  })
}

/** CSS 的 1–4 值盒展开（`inset: a b` → 上下 a、左右 b）。 */
function expandBox(parts: string[]): Record<Side, string> {
  const [a, b, c, d] = parts
  if (parts.length === 1) return { top: a!, right: a!, bottom: a!, left: a! }
  if (parts.length === 2) return { top: a!, right: b!, bottom: a!, left: b! }
  if (parts.length === 3) return { top: a!, right: b!, bottom: c!, left: b! }
  return { top: a!, right: b!, bottom: c!, left: d! }
}

type Edge = { width: string | null; style: string | null; color: string | null }
/** 故障种类。自检按这个标签断言「捕到的是哪一条理由」，而不是只看「非空」。 */
type FaultKind = 'no-box' | 'unpinned' | 'style' | 'width' | 'color' | 'undeclared-token'
type Fault = { kind: FaultKind; why: string }

/**
 * 这组覆盖层规则「在一格有内容的 Region 里画不出四条可见边」的全部理由。
 *
 * 空数组 = 画得出。判据分四层，每层都有实测存活的变异做靶子（见调用处）：
 *   1. 有盒：`::after` 缺 `content` 时根本不生成盒
 *   2. 四边被钉住：绝对定位的伪元素在没被钉住的方向按内容收缩，空 content 会坍成角上一个小点
 *   3. 四条边各有非 none 的 style、非 0 的宽、非透明的色
 *   4. 用到的 token 都真的有声明（否则取值退化成空，与「写了个透明色」是不同的病、要分开报）
 */
function focusRingFaults(overlays: Rule[], tokens: Map<string, string[]> = TOKENS): Fault[] {
  const faults: Fault[] = []
  const fail = (kind: FaultKind, why: string): void => void faults.push({ kind, why })
  const edges: Record<Side, Edge> = {
    top: { width: null, style: null, color: null },
    right: { width: null, style: null, color: null },
    bottom: { width: null, style: null, color: null },
    left: { width: null, style: null, color: null }
  }
  const pinned = new Set<Side>()
  const used = new Set<string>()
  let box: string | null = null

  for (const rule of overlays) {
    for (const [property, raw] of declarations(rule)) {
      const value = raw.trim()
      for (const match of value.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) used.add(match[1]!)

      if (property === 'content') box = value
      if (property === 'inset') for (const side of SIDES) pinned.add(side)
      if (property === 'inset-block') { pinned.add('top'); pinned.add('bottom') }
      if (property === 'inset-inline') { pinned.add('left'); pinned.add('right') }
      if ((SIDES as readonly string[]).includes(property)) pinned.add(property as Side)

      const side = /^border-(top|right|bottom|left)$/.exec(property)?.[1] as Side | undefined
      if (property === 'border' || side) {
        const parts = splitTopLevel(value)
        const style = parts.find((part) => BORDER_STYLES.has(part.toLowerCase())) ?? null
        const rest = parts.filter((part) => !BORDER_STYLES.has(part.toLowerCase()))
        const edge: Edge = {
          style,
          width: rest.find((part) => isWidthPart(part, tokens)) ?? null,
          color: rest.find((part) => !isWidthPart(part, tokens)) ?? null
        }
        for (const target of side ? [side] : SIDES) edges[target] = { ...edge }
      }
      for (const axis of ['width', 'style', 'color'] as const) {
        if (property === `border-${axis}`) {
          const expanded = expandBox(splitTopLevel(value))
          for (const target of SIDES) edges[target][axis] = expanded[target]
        }
        const perSide = new RegExp(`^border-(top|right|bottom|left)-${axis}$`).exec(property)?.[1]
        if (perSide) edges[perSide as Side][axis] = value
      }
    }
  }

  if (box === null) fail('no-box', '没有 content 声明：::after 根本不生成盒，一个像素都不画')
  else if (box.toLowerCase() === 'none') fail('no-box', 'content: none，::after 不生成盒')
  const missing = SIDES.filter((side) => !pinned.has(side))
  if (missing.length > 0) {
    fail(
      'unpinned',
      `只钉住了 ${SIDES.length - missing.length}/4 个方向（缺 ${missing.join('/')}）：绝对定位的伪元素` +
        '在没被钉住的方向按内容收缩，content 是空串时会坍成角上一个只有边框那么大的小点'
    )
  }
  for (const side of SIDES) {
    const edge = edges[side]
    if (edge.style === null) fail('style', `${side} 边没有 border-style，缺省是 none：这条边不画`)
    else if (['none', 'hidden'].includes(edge.style.toLowerCase())) fail('style', `${side} 边的 border-style 是 ${edge.style}`)
    if (edge.width === null) fail('width', `${side} 边没有边宽`)
    else if (isZeroWidth(edge.width, tokens)) fail('width', `${side} 边的边宽是 ${edge.width}（0 宽等于不画）`)
    if (edge.color === null) fail('color', `${side} 边没有边色`)
    else if (isInvisibleColor(edge.color, tokens)) fail('color', `${side} 边的边色 ${edge.color} 是透明/无色，画了也看不见`)
  }
  for (const token of used) {
    if (!tokens.get(token)?.length) fail('undeclared-token', `用到 ${token} 但样式里没有它的声明，取值会退化成空`)
  }
  return faults
}

describe('Region 焦点必须看得出来（#339）', () => {
  it('自检：能按类名精确取到规则，且不把前缀相同的邻居算进来', () => {
    // 认不出任何规则的读取器会让下面的断言因为"没找到"而全绿。这条同时钉住词法边界：
    // `.workbench-region-split` 与 `.workbench-region--active` 都以 `.workbench-region` 开头，
    // 混进来就会污染"默认态有哪些声明"。
    const exact = /\.workbench-region(?![\w-])/
    const base = rulesForClass('workbench-region')
    expect(base.length, '读不到 .workbench-region 的规则——样式入口或类名变了').toBeGreaterThan(0)
    // 判据落在**命中的那一支**上，不在整条选择器字符串上：`.workbench-region-split,
    // .workbench-region` 是一条合法的逗号组，其中一支正是我们要的；按整条判会把它当违规。
    for (const rule of base) {
      const matched = rule.selector.split(',').map((part) => part.trim()).filter((part) => exact.test(part))
      expect(matched.length, `${rule.selector} 被取进来了却没有任何一支精确命中`).toBeGreaterThan(0)
      for (const part of matched) {
        expect(part, `词法边界失效：${part} 被当成了 .workbench-region 本身`).not.toMatch(
          /\.workbench-region(?:--|-)\w/
        )
      }
    }
    // 反向：焦点态那条确实取得到，且没被上面那组吞掉。
    expect(rulesForClass('workbench-region--active').length).toBeGreaterThan(0)
    // 判据自己认得出该拒的拼法——否则"没找到违规"与"认不出违规"在结果上同形。
    expect(exact.test('.workbench-region--active')).toBe(false)
    expect(exact.test('.workbench-region-split')).toBe(false)
    expect(exact.test('.workbench-region')).toBe(true)
  })

  /**
   * 两个消费者读的是**同一次**判定（#350）。
   *
   * 这条是行为层：类名与「原生视图要不要让位」必须同步取值。分开各算一次的后果实测过——BrowserPane
   * 那侧问的是「有没有 `.workbench-region` 祖先」，而环宽那个自定义属性声明在 `:root`，任何 Region
   * 都继承得到，于是未聚焦的 browser 区也内缩 2px，露出底下 `.browser-stage` 的深色成一圈无环的黑边。
   *
   * 判据钉住这一对的**联动**而不是各自的取值：把 `nativeViewYieldsToRing` 写成常量 true 或 false，
   * 或让它读另一次比较，这里都红。
   */
  it('类名与原生视图让位量出自同一次判定', () => {
    const focused = regionFocusExpression('r1', 'r1', 2)
    const other = regionFocusExpression('r1', 'r2', 2)
    const none = regionFocusExpression(null, 'r1', 2)

    expect(focused.className, '聚焦的那一格没挂上焦点类名').toBe(REGION_FOCUS_CLASS)
    expect(other.className, '未聚焦的那一格也挂上了焦点类名——每格都亮，分不出焦点').toBe('')
    expect(none.className, '没有活动区时仍挂焦点类名').toBe('')

    // 联动：让位量恒等于「类名非空」。写死成任一常量，或按另一次比较取值，这里都红。
    for (const [label, expression] of [
      ['聚焦', focused], ['未聚焦', other], ['无活动区', none]
    ] as const) {
      expect(
        expression.nativeViewYieldsToRing,
        `${label}那一格：让位量与类名不同步——原生视图与焦点环各读一次判定，必漂移`
      ).toBe(expression.className !== '')
    }
    // 自检：上面这批样本真的两种情形都覆盖到了，否则那条恒等式只在一侧被质询过。
    expect(
      new Set([focused, other, none].map((expression) => expression.nativeViewYieldsToRing)).size,
      '样本只覆盖了让位量的一个取值——上面那条联动断言有一半没被执行'
    ).toBe(2)
  })

  it('焦点判定按 activeRegionId 分岔，且两个分支给出不同的类名', () => {
    const conditional = activeRegionConditional()
    expect(
      conditional,
      'region-focus.ts 里没有任何按焦点分岔的三元——每一格长得一样，焦点无从表达'
    ).not.toBeNull()
    // 两个分支必须真的不同。写成同一个值（两边都加类、或两边都不加）在类型与文本上都合法，
    // 而屏幕上就是"分不出哪一格是焦点"。
    expect(
      conditional!.whenActive.trim(),
      '按焦点分岔的两个分支给出同一个类名，等于没有分岔'
    ).not.toBe(conditional!.whenNot.trim())
    // 焦点那一侧必须真的给出一个类名，不能是空串（空串意味着焦点态没有任何样式挂载点）。
    expect(conditional!.whenActive, '焦点分支没有给出类名').toMatch(/[a-zA-Z]/)
  })

  /**
   * 判定算出来了，但**没人把它挂到那一格上**：这一层单独守（#350 的接线层）。
   *
   * 分两层的理由与 browser-bounds-sync 那侧同构（extracting-to-lib-only-fixes-half）：判定收进
   * `region-focus.ts` 后上面那条断言变得好写了，可「壳里有没有真的用它」照旧无人守——保留 import、
   * 算完丢掉、className 写死成 `'workbench-region'`，上面每一条都不红，而屏幕上焦点彻底消失。
   *
   * 判据是 import 关系加取值位（guard-criterion-must-be-import-relation：`not.toContain('name(')`
   * 会被裸标识符绕过）：组件必须从那个模块 import 判定函数，且 Region 的 className 里真的带着它的
   * `className` 字段。
   */
  it('组件真的用那次判定给 Region 挂类名，而不是只 import 了它', () => {
    const source = readFileSync(WORKBENCH_TSX, 'utf8')
    expect(
      /import\s*\{[^}]*\bregionFocusExpression\b[^}]*\}\s*from\s*'[^']*\/region-focus'/.test(source),
      'WorkspaceWorkbench 没有从 lib/region-focus import regionFocusExpression——' +
        '焦点类名与原生视图让位量各算一次，必漂移（read-key-and-write-key-must-be-one-decision）'
    ).toBe(true)

    // 取 Region 那个 <section> 的 className 表达式，判它引用了判定的结果。写死类名、或漏掉
    // 焦点那一段（每格都不亮）都在这里红。
    //
    // 按**身份**找那个元素（`data-workbench-region-id` 只有它带），不按 className 的内容找。
    // 这一步换过一次判据，原因值得留着：原来是「className 文本里出现 workbench-region」，而
    // 那个基类名收进 REGION_CLASS 常量之后，真正的 Region 立刻对抽取器隐形——同时
    // `workbench-region__close` / `workbench-region-split` 这些**兄弟**类名仍然命中，于是
    // `length > 0` 那条自检照旧通过，把「抽到的不是主角」放行了（fixture-wrong-shape-blinds-the-test
    // 的同族：错形状的样本让判据失明，而自检恰好被旁证满足）。按身份取则只有一个候选，
    // 数量断言 `toBe(1)` 同时守住「找到了」与「找到的就是它」。
    const ast = ts.createSourceFile('WorkspaceWorkbench.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const REGION_ID_ATTRIBUTE = 'data-workbench-region-id'
    const classNames: string[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText(ast) === REGION_ID_ATTRIBUTE) {
        // 属性 → JsxAttributes → 开标签。同一个标签上的 className 就是我们要判的那个。
        const tag = node.parent.parent
        if (ts.isJsxOpeningElement(tag) || ts.isJsxSelfClosingElement(tag)) {
          for (const property of tag.attributes.properties) {
            if (ts.isJsxAttribute(property) && property.name.getText(ast) === 'className') {
              classNames.push(property.initializer?.getText(ast) ?? '<无值>')
            }
          }
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)
    // 自检兼身份断言：带那个 data 属性的元素恰好一个，且它带 className。抽不到（组件重构）
    // 与抽到多个（身份不再唯一）都让下面的判据失去落点，所以这里钉死 1。
    expect(
      classNames.length,
      `带 ${REGION_ID_ATTRIBUTE} 且有 className 的元素有 ${classNames.length} 个，应恰好 1 个——` +
        '下面那条守卫失去落点（组件重构过？）'
    ).toBe(1)
    expect(
      classNames.some((expression) => /\bfocus\.className\b/.test(expression)),
      `Region 的 className 里没有那次判定的结果（抽到的是 ${classNames.join(' | ')}）——` +
        '焦点类名写死了，每一格长得一样'
    ).toBe(true)
    // 基类名也必须取自常量。它是 BrowserPane 反查 Region 祖先时用的同一个字符串（见
    // regionAncestorOf）：手抄回字面量，两侧就重新失去编译期联系，改名时一侧静默读不到。
    expect(
      classNames.some((expression) => /\bREGION_CLASS\b/.test(expression)),
      `Region 的 className 没有引用 REGION_CLASS（抽到的是 ${classNames.join(' | ')}）——` +
        '基类名被手抄回字面量，与 BrowserPane 反查用的那个字符串重新分居两处'
    ).toBe(true)
  })

  /**
   * **喂进那次判定的是哪两个 id**（#352 的 S1）。
   *
   * 上面那条守「组件用了这次判定的结果」，这条守「判定拿到的是对的输入」。两者能各自独立坏掉，
   * 而后者坏掉时前者一条都不红：把第一实参从 `tab.layout.activeRegionId` 换成 `tab.id`，两个
   * 都是 `string`，tsc 全程沉默，`focus.className` 照旧出现在 className 里——而 `===` 比的是
   * 两个**互不相交的 id 空间**，`focused` 恒为 false，于是没有任何一格再画得出焦点环。那正是
   * #339 那次事故的原样，实测这个变异在 23 条全绿 + tsc exit 0 下存活。
   *
   * 判据落在两个实参的**末位属性名**上，而不是整条路径：钉死 `tab.layout.activeRegionId` 会让
   * 任何合理重构（换个中间层名字）误红，而末位属性名恰好是「取的是哪个概念」这句话——`id`、
   * `titleRegionId`、`activeTabId` 全都不等于 `activeRegionId`，全都会红。
   */
  it('那次判定的两个实参分别是活动区 id 与本格 id，不是别的 id', () => {
    const source = readFileSync(WORKBENCH_TSX, 'utf8')
    const ast = ts.createSourceFile('WorkspaceWorkbench.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const calls: string[][] = []
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'regionFocusExpression') {
        calls.push(node.arguments.map((argument) => argument.getText(ast)))
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)
    // 自检：调用点恰好一个。零个说明接线整段没了（上面那条会先红）；多个说明焦点判定又被分成
    // 了几次算——那正是 region-focus.ts 存在的理由被推翻，得有人重新想清楚。
    expect(calls.length, 'regionFocusExpression 的调用点不是恰好 1 个，焦点判定又分岔了').toBe(1)
    const [activeArgument, regionArgument] = calls[0]!
    expect(calls[0]!.length, 'regionFocusExpression 的实参个数变了，下面几条判据需要跟上').toBe(3)
    expect(
      activeArgument,
      `第一实参是 \`${activeArgument}\`，末位属性名不是 activeRegionId——` +
        '喂进去的是另一个 id 空间的值，`===` 恒不成立，没有任何一格画得出焦点环（#339 原样）'
    ).toMatch(/\.activeRegionId$/)
    expect(
      regionArgument,
      `第二实参是 \`${regionArgument}\`，末位属性名不是 regionId——比的不是"这一格"`
    ).toMatch(/\.regionId$/)
    // 两个实参必须是不同的表达式：同一个喂两遍（`node.regionId, node.regionId`）让 `===` 恒成立，
    // 于是**每一格**都亮着焦点环——同样分不出焦点，而上面两条各自都通过。
    expect(
      activeArgument,
      '两个实参是同一个表达式——`===` 恒成立，每一格都亮焦点环'
    ).not.toBe(regionArgument)
  })

  /**
   * 那两个 id 真的**来自互不相交的空间**（上面那条的行为侧配套）。
   *
   * 上面按 AST 判「取的是哪个字段」，这条按行为判「喂错了会怎样」：拿一个 Tab id 当活动区 id 喂
   * 进去，必须什么都不亮。少了这条，AST 那侧一旦被重构绕过（比如中间塞一个同名 getter），
   * 就没有任何东西还在陈述这件事的后果。
   */
  it('喂进另一个 id 空间的值时什么都不亮（不是碰巧相等就亮）', () => {
    const regionId = 'region-1'
    const tabId = 'tab-1'
    expect(
      regionFocusExpression(tabId, regionId, 2).className,
      '拿 Tab id 当活动区 id 喂进去竟然亮了——两个 id 空间被混用而无人发现'
    ).toBe('')
    expect(regionFocusExpression(tabId, regionId, 2).nativeViewYieldsToRing).toBe(false)
    // 判别器在场：同一个 regionId 喂对了必须亮，否则上面那条在"永远不亮"的实现下也恒真。
    expect(
      regionFocusExpression(regionId, regionId, 2).className,
      '判别器缺席：喂对了也不亮，上面那条断言无从分辨'
    ).toBe(REGION_FOCUS_CLASS)
  })

  /**
   * 焦点环表达的是「在若干候选里选中了这一个」——**只有一个候选时它没有内容**。
   *
   * 用户原话：「现在表示选中的框, 除了活跃的 region 有, 整个界面也有」。现场是两层环各自无条件跟着
   * 「谁是活动的」画，而两层都有「候选恒为一」的常态形态：不分屏时唯一那个 Pane 组铺满整个工作区且
   * 恒等于 `activeGroupId`；单格 Tab 里唯一那个 Region 铺满内容区且恒等于 `activeRegionId`。于是
   * 最常见的形态（单窗口、不分屏、一格）界面外沿一圈绿框、往里 2px 再一圈，两圈都不携带信息。
   *
   * 判据分三层，各自能独立坏掉：
   *   1. 那条规则本身（{@link focusRingExpressesChoice}）：1 个不画、2 个画、0 个保守不画。
   *   2. 两个判定都真的**过**了那条规则，且**两个返回字段一起**变——只让类名变空而让位量照旧为真，
   *      就是 #350 那圈「无环的深边」原样（unfocused browser 区内缩 2px 露出底色，却没有绿环）。
   *   3. 组件真的把候选数喂进去（接线层，见下一条）。
   */
  it('只有一个候选时两层焦点环都不画，有两个时才画', () => {
    // 规则本身。`> 1` 而不是 `!== 1`：数不出候选（0）时保守地不画，而不是把「数坏了」画成一圈环。
    expect(focusRingExpressesChoice(1), '只有一格时环仍然画——整个界面镶一圈绿边，且不表达任何选择').toBe(false)
    expect(focusRingExpressesChoice(2), '有两格时环不画了——焦点在哪彻底看不出（#339 原样）').toBe(true)
    expect(focusRingExpressesChoice(0), '数出 0 个候选时画了环——「数坏了」不该表达成「选中了」').toBe(false)

    // Region 那一层：同一格、同一个活动 id，只有候选数不同。
    const alone = regionFocusExpression('r1', 'r1', 1)
    const amongTwo = regionFocusExpression('r1', 'r1', 2)
    expect(alone.className, '单格 Tab 里那唯一一格仍挂焦点类名——内容区外沿恒亮一圈').toBe('')
    expect(amongTwo.className, '两格时聚焦那格不挂类名了').toBe(REGION_FOCUS_CLASS)
    // 让位量必须跟着一起走。只改类名那一侧的后果是 browser 那格仍内缩 2px 却没有环（#350 原样），
    // 而上面两条断言照旧通过——这正是 regionFocusExpression 返回一对而不是一个类名的理由。
    expect(
      alone.nativeViewYieldsToRing,
      '单格时类名不挂了，但原生视图还在让位——browser 那格镶一圈无环的深边（#350 原样）'
    ).toBe(false)
    expect(amongTwo.nativeViewYieldsToRing, '两格时聚焦那格的原生视图不让位，环的三边会被物理盖掉').toBe(true)

    // Pane 组那一层同样。它没有原生视图要让位，故只有类名。
    expect(
      paneGroupFocusClass('g1', 'g1', 1),
      '不分屏时唯一那个 Pane 组仍挂焦点类名——整个界面外沿恒亮一圈（用户报的就是这个）'
    ).toBe('')
    expect(paneGroupFocusClass('g1', 'g1', 2), '分屏后活动那组不挂类名了，分不出焦点').toBe(
      PANE_GROUP_FOCUS_CLASS
    )
    // 两层各自还得保住「不是活动的那个不画」这一半：把候选数判据写成析取（`||`）而不是合取，
    // 上面每一条都通过，而屏幕上**每一格**都亮着环。
    expect(
      regionFocusExpression('r1', 'r2', 2).className,
      '两格时未聚焦那格也亮了——候选数那一问被写成了析取，每格都画环'
    ).toBe('')
    expect(paneGroupFocusClass('g1', 'g2', 2), '分屏后未活动那组也亮了').toBe('')
  })

  /**
   * 候选数真的从组件**喂**进去（接线层）。
   *
   * 与上一条分开的理由同 #350 那次：判定改好了而壳里没接，上一条一条都不红。而且这条判的不是
   * 「有没有第三个实参」——喂一个字面量 `2` 类型合法、上一条全绿，环就重新变成无条件恒亮
   * （记忆 optional-prop-only-buys-silence：可选/宽松的形状只买到 tsc 的沉默）。
   *
   * 判据落在实参的**形状**上：它必须是一次「数出来」的表达式，而不是常量。两层各判一次——
   * 只钉一处会让另一层静默留在旧形状（记忆 duplicated-rule-defeats-the-fix）。
   */
  it('两层判定的候选数都是数出来的，不是写死的常量', () => {
    const source = readFileSync(WORKBENCH_TSX, 'utf8')
    const ast = ts.createSourceFile('WorkspaceWorkbench.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    // 两层判定各自的「候选数」是第几个实参，以及那个数该从哪个概念数出来。
    const WIRING: Record<string, { index: number; counts: RegExp; concept: string }> = {
      // Region 层：Tab 内的格。`regionCount` 是 WorkbenchRegionLeaf 里 Object.keys(tab.regions).length。
      regionFocusExpression: { index: 2, counts: /^regionCount$|\.length$/, concept: '这张 Tab 里的格数' },
      // Pane 组层：分屏树里的**叶子**。刻意不是 `layout.groups.length`——那张表里可以躺着不在树里的
      // 分组（#312 的浮层形态），它们不经这里渲染、屏幕上不是候选。
      paneGroupFocusClass: { index: 2, counts: /^groupIds\(.*\)\.length$/, concept: '分屏树里的叶子数' }
    }
    const calls = new Map<string, string[][]>()
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(ast)
        if (WIRING[name] !== undefined) {
          const list = calls.get(name) ?? []
          list.push(node.arguments.map((argument) => argument.getText(ast)))
          calls.set(name, list)
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)

    for (const [name, { index, counts, concept }] of Object.entries(WIRING)) {
      const sites = calls.get(name) ?? []
      // 在场自检：调用点恰好一个。零个说明接线整段没了；多个说明这一层的判定又被分成几次算。
      expect(sites.length, `${name} 的调用点是 ${sites.length} 个，应恰好 1 个——判定分岔或接线丢了`).toBe(1)
      const argument = sites[0]![index]
      expect(
        argument,
        `${name} 没有收到第 ${index + 1} 个实参（${concept}）——候选数这一问在壳里根本没接上，` +
          '环回到无条件恒亮'
      ).toBeDefined()
      // 形状判据：必须是一次数出来的表达式。写死 `2`（恒画）或 `1`（恒不画）在类型上都合法，
      // 而上一条那些纯函数断言对它完全失明。
      expect(
        argument,
        `${name} 的候选数实参是 \`${argument}\`，不像一次数出来的取值（期望匹配 ${counts}）——` +
          `写死一个数就让环与「${concept}」彻底脱钩`
      ).toMatch(counts)
    }
  })

  /**
   * Pane 组那个 `<section>` 真的**用**了那次判定（接线层的另一半）。
   *
   * 上一条只判「调用点在、实参是数出来的」。实测那还不够：把 className 里那一段换回内联三元
   * （`layout.activeGroupId === group.id ? 'pane-group--focused' : ''`），判定照旧被算出来、
   * 实参照旧数得对，只是**没人用它**——环回到无条件恒亮，而 13 条全绿、tsc 也沉默
   * （`noUnusedLocals` 没开，所以那个白算的常量不报错）。这正是记忆
   * extracting-to-lib-only-fixes-half：抽进 lib 只解决内容那一半，「壳里有没有执行到」照旧无人守。
   *
   * 判据两条，缺一不可：
   *   - className 里出现那次判定的结果（按**判定的绑定名**取，重命名不误红）；
   *   - className 里**不出现**那个焦点类名的字面量——手抄一份就绕过了整条判定
   *     （Region 那侧同理，两层各判一次；只钉一处会让另一层静默留在旧形状）。
   */
  it('两层的容器 className 都真的引用那次判定，而不是自己手抄类名', () => {
    const source = readFileSync(WORKBENCH_TSX, 'utf8')
    const ast = ts.createSourceFile('WorkspaceWorkbench.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

    /** 一次调用的结果被绑到了哪个名字上（直接内联在 JSX 里时返回那次调用本身的文本）。 */
    function decisionToken(callee: string): string | null {
      let found: string | null = null
      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.getText(ast) === callee) {
          const parent: ts.Node = node.parent
          found =
            ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
              ? parent.name.text
              : node.getText(ast)
        }
        ts.forEachChild(node, walk)
      }
      ts.forEachChild(ast, walk)
      return found
    }

    /** 带某个 data 属性的那个元素的 className 表达式（按身份取，不按类名内容取）。 */
    function classNameOfElementWith(attribute: string): string[] {
      const out: string[] = []
      const walk = (node: ts.Node): void => {
        if (ts.isJsxAttribute(node) && node.name.getText(ast) === attribute) {
          const tag = node.parent.parent
          if (ts.isJsxOpeningElement(tag) || ts.isJsxSelfClosingElement(tag)) {
            for (const property of tag.attributes.properties) {
              if (ts.isJsxAttribute(property) && property.name.getText(ast) === 'className') {
                out.push(property.initializer?.getText(ast) ?? '<无值>')
              }
            }
          }
        }
        ts.forEachChild(node, walk)
      }
      ts.forEachChild(ast, walk)
      return out
    }

    const LAYERS = [
      {
        what: 'Region',
        callee: 'regionFocusExpression',
        attribute: 'data-workbench-region-id',
        literal: REGION_FOCUS_CLASS
      },
      {
        what: 'Pane 组',
        callee: 'paneGroupFocusClass',
        attribute: 'data-pane-group-id',
        literal: PANE_GROUP_FOCUS_CLASS
      }
    ] as const

    for (const { what, callee, attribute, literal } of LAYERS) {
      const token = decisionToken(callee)
      expect(token, `${what} 那层找不到 ${callee} 的调用点——判定整段没了`).not.toBeNull()
      const classNames = classNameOfElementWith(attribute)
      // 身份自检：带那个 data 属性且有 className 的元素恰好一个。抽不到与抽到多个都让判据失去落点。
      expect(
        classNames.length,
        `带 ${attribute} 且有 className 的元素有 ${classNames.length} 个，应恰好 1 个——` +
          '组件重构过？下面两条判据失去落点'
      ).toBe(1)
      const expression = classNames[0]!
      expect(
        expression.includes(token!),
        `${what} 的 className 里没有出现那次判定的结果 \`${token}\`（抽到的是 ${expression}）——` +
          '判定算了却没人用，环回到无条件恒亮'
      ).toBe(true)
      // 手抄那个类名就绕过了整条判定：算出来的 `''` 与手写的字面量在同一个模板串里并存也合法。
      expect(
        expression.includes(`'${literal}'`) || expression.includes(`"${literal}"`),
        `${what} 的 className 里手抄了 \`${literal}\` 这个字面量（${expression}）——` +
          '那一段绕过了候选数判定，环恒亮'
      ).toBe(false)
    }
  })

  it('焦点类名有承重声明，不是一条空规则', () => {
    // 判定导出的那个类名与 CSS 画的那个必须是同一个：改一侧的拼写，另一侧沉默，焦点态就没有任何
    // 样式挂载点。用导出的常量去查规则，两边就只有一个真相（下面几条也一并跟着它走）。
    expect(
      REGION_FOCUS_CLASS,
      'region-focus.ts 导出的焦点类名与 CSS 里画环的那个不一致——类名挂上了但没有任何规则命中'
    ).toBe('workbench-region--active')
    const active = rulesForClass(REGION_FOCUS_CLASS)
    const properties = new Set(active.flatMap((rule) => [...declarations(rule).keys()]))
    // #111 的先例：只判选择器在不在场，把 body 清空即可让焦点在屏幕上彻底消失而守卫沉默。
    expect(
      [...properties],
      '.workbench-region--active 没有任何声明——焦点态是一条空规则，屏幕上看不出任何差别'
    ).not.toEqual([])
  })

  it('焦点与非焦点在同一个属性上取到不同的值', () => {
    const base = rulesForClass('workbench-region')
    const active = rulesForClass('workbench-region--active')
    const baseDeclarations = new Map<string, string>()
    for (const rule of base) for (const [key, value] of declarations(rule)) baseDeclarations.set(key, value)

    const differing: string[] = []
    for (const rule of active) {
      for (const [property, value] of declarations(rule)) {
        // 默认态没声明这个属性 → 焦点态是在无到有地加东西，那本身就是差别。
        if (!baseDeclarations.has(property)) {
          differing.push(property)
          continue
        }
        if (baseDeclarations.get(property) !== value) differing.push(property)
      }
    }
    // 「有声明」不等于「有差别」：焦点态写一条与默认态逐字相同的声明（本仓默认态就有一条
    // `box-shadow: inset 0 0 0 1px transparent` 占位），编译与上面那条断言都过，而用户
    // 看到的两格一模一样。
    expect(
      differing,
      '焦点态的每一条声明都与默认态取值相同——两格在屏幕上没有任何差别'
    ).not.toEqual([])
  })

  it('焦点表达画在定位不透明内容之上——不是 inset 阴影，也不是 outline', () => {
    // 上面三条全绿也可能一个像素都画不出来。这条已经**两次**抓到真缺陷，判据也因此换过两次：
    //
    // 第一次：`inset box-shadow` 属元素**自身的背景层**，子元素背景画在它之上。当时的判据是
    // 「必须是 outline 族或 ::after 覆盖层」——它挡住了 inset 阴影，但为下一个坏修复背了书。
    //
    // 第二次（本条现在的形状）：**outline 也不行**。CSS 2.1 Appendix E 的绘制顺序里父元素 outline 是
    // 第 7 步，`z-index: auto` 的**定位后代**是第 8 步——定位后代画在父层 outline 之后是规范保证的。
    // Region 内恰好有这种后代：`.terminal-view`（terminal.css:9 `position: relative`）带满铺不透明
    // 背景，于是 terminal 与 agent 两种区（终端优先产品里最常见的两种）焦点框完全不可见，而当时
    // 5/5 全绿。**判据的对象不是「属性属于哪一族」，而是「这条声明能不能排到定位内容之上」**——
    // 只有真正参与层叠的定位覆盖层能做到，故只认那一种，且必须逐项检查它排上去的三个条件。
    //
    // 同族的绕过形状（都匹配"选择器带 ::after"这种旧判据、都实测不可见）：无 position 的伪元素是
    // 零尺寸在流块；有 position 无 z-index 的与内容同序、被后面的定位兄弟盖住。所以三项缺一不可。
    //
    // **两个类名都要判**：这个毛病同时存在于 Region 与 Pane 组两级（`.pane-group` 的内容行就是
    // `.workbench-region`，定位不透明，同样实测不可见）。只钉一处会让另一处静默留在旧形状——
    // 记忆 duplicated-rule-defeats-the-fix 的形状：同一件事有两个写入点时，改一处的人以为改完了。
    const MIN_OVERLAY_Z = 37 // Region 内最高的常驻面是 terminal.css:141 的 36
    for (const className of [REGION_FOCUS_CLASS, PANE_GROUP_FOCUS_CLASS]) {
      const overlays = focusOverlayRules(className)
      expect(
        overlays.length,
        `.${className} 的焦点态没有伪元素覆盖层规则。inset 阴影画在自身背景层、outline 画在定位后代` +
          '之下（规范绘制顺序 7 vs 8），Region 里的 `.terminal-view` 正是定位不透明后代——' +
          '那两种画法在 terminal/agent 区一个像素都出不来（#339 两次的真因）。'
      ).toBeGreaterThan(0)

      // 覆盖层要真的排到内容之上，三个条件缺一不可，逐项报告缺的是哪一个。
      const merged = new Map<string, string>()
      for (const overlay of overlays) {
        for (const [property, value] of declarations(overlay)) merged.set(property, value)
      }
      expect(
        merged.get('position'),
        `.${className} 的覆盖层没有 position: absolute——无定位的伪元素是零尺寸在流块，被定位内容盖住`
      ).toBe('absolute')
      const z = Number.parseInt(merged.get('z-index') ?? '', 10)
      expect(
        z,
        `.${className} 的覆盖层 z-index 是 ${merged.get('z-index') ?? '（未声明）'}，压不过 Region 里` +
          `最高的常驻面（terminal-service-window 的 36）——同序或更低会被后面的定位兄弟盖住`
      ).toBeGreaterThanOrEqual(MIN_OVERLAY_Z)
      // 画得出来还不够：它不能吃掉指针事件，否则终端整块点不动（焦点框是告示不是遮挡）。
      expect(
        merged.get('pointer-events'),
        `.${className} 的覆盖层没有 pointer-events: none——它铺满整格，会吃掉终端/编辑器的全部点击`
      ).toBe('none')
    }

    // 自检：判据认得出该拒的每一种拼法，否则"没找到违规"与"认不出违规"在结果上同形。
    // 三种都曾经是（或差一点成为）本仓的真实形状：前两种是 #339 两轮修复各自的原样声明，
    // 第三种是审计实测能绕过旧判据且 5/5 全绿的那个。
    const rejected = [
      { why: 'inset 阴影（第一次事故的原样）', body: 'box-shadow: inset 0 0 0 1px var(--green-line);' },
      { why: 'outline（第二次事故的原样）', body: 'outline-color: var(--green-2);' },
      { why: '无 position 的伪元素（审计实测可绕过旧判据）', body: "content: ''; border: 2px solid var(--green-2);" }
    ]
    for (const { why, body } of rejected) {
      const probed = declarations({ selector: '.probe', body })
      expect(
        probed.get('position') === 'absolute' &&
          Number.parseInt(probed.get('z-index') ?? '', 10) >= MIN_OVERLAY_Z &&
          probed.get('pointer-events') === 'none',
        `判据把「${why}」错认成能画在定位内容之上——那正是它要挡的形状`
      ).toBe(false)
    }
    // 反向自检：正确的那种拼法必须被接受，否则这一族退化成"什么都拒"的恒红/死判据。
    const accepted = declarations({
      selector: '.probe::after',
      body: "content: ''; position: absolute; z-index: 37; inset: 0; pointer-events: none; border: 2px solid var(--green-2);"
    })
    expect(
      accepted.get('position') === 'absolute' &&
        Number.parseInt(accepted.get('z-index') ?? '', 10) >= MIN_OVERLAY_Z &&
        accepted.get('pointer-events') === 'none',
      '判据认不出正确的定位覆盖层写法——那它挡的不是坏形状而是所有形状'
    ).toBe(true)
  })

  /**
   * 排到内容之上、还得**真的画出四条看得见的边**。
   *
   * 上面那条只判了「排得上去」（position / z-index / pointer-events），于是这四种改法各自都让屏幕上
   * 一个像素都没有、或只剩一条孤线，而它 18/18 全绿——我在本轮逐条实测过，四条全部存活：
   *   - 删掉 `inset: 0`：绝对定位的伪元素在没被钉住的方向按内容收缩，`content: ''` 是空的，于是整圈
   *     框坍成左上角一个只有边框那么大的小点。
   *   - `border` 改成 `border-top`：**正是 #339 用户报的那个现场**——一条孤零零的上边线，另外三边没有。
   *   - `var(--green-2)` 改成 `transparent`：三个属性照旧齐全、边宽照旧从 SSOT 取，画出来是透明的。
   *   - 删掉 `content: ''`：`::after` 不生成盒，什么都不画。
   *
   * 所以判据不能停在「有没有 border 族声明」。它要能回答的是**「这条差别在一格有内容的 Region 里
   * 画得出来吗」**（记忆 inset-shadow-is-occluded-by-children 的同一个问法）：有盒、四边被钉住、
   * 四条边各有非 none 的 style、非 0 的宽、非透明的色。取值里的 `var()` 必须展开到底再判——
   * `transparent` 可以藏在一个 token 后面，而「边色是不是 var(...)」这种表层判据对它完全失明。
   */
  it('焦点环真的画得出四条看得见的边（不是坍成一点、一条孤线或透明）', () => {
    for (const className of [REGION_FOCUS_CLASS, PANE_GROUP_FOCUS_CLASS]) {
      const overlays = focusOverlayRules(className)
      expect(
        overlays.length,
        `.${className} 取不到覆盖层规则——下面的判据会跑在空规则上，把「什么都没画」读成没有故障`
      ).toBeGreaterThan(0)
      expect(
        focusRingFaults(overlays).map((fault) => fault.why),
        `.${className} 的焦点环在有内容的格子里画不出四条可见的边`
      ).toEqual([])
    }

    // 自检：判据认得出每一种改法，**且报的是那一条理由**。只断言「非空」不够——一份样本可以因为
    // 另一条毛病而红，于是那条本该被验的判据其实从没跑对过（记忆 cover-key-cannot-be-in-two-families）。
    // 前四条是我在本轮对 workbench.css 逐条实测、旧判据下全部存活的真变异。
    const base = "content: ''; position: absolute; z-index: 37; inset: 0; pointer-events: none;"
    // token 表按需注入：透明色要藏在一个 token 后面才验得到展开器，而那个 token 不该塞进产品样式。
    const probeTokens = new Map(TOKENS)
    probeTokens.set('--probe-clear', ['transparent'])
    const survivors: { kind: FaultKind; why: string; body: string }[] = [
      { kind: 'unpinned', why: '删掉 inset:0（伪元素坍成角上一个点）', body: "content: ''; border: 2px solid var(--green-2);" },
      { kind: 'style', why: 'border 改成 border-top（#339 的孤零上边线）', body: `${base} border-top: 2px solid var(--green-2);` },
      { kind: 'color', why: '边色换成 transparent（画了看不见）', body: `${base} border: 2px solid transparent;` },
      { kind: 'no-box', why: '删掉 content（::after 不生成盒）', body: `${base.replace("content: '';", '')} border: 2px solid var(--green-2);` },
      { kind: 'color', why: '边色换成藏在 token 后的透明色', body: `${base} border: 2px solid var(--probe-clear);` },
      { kind: 'undeclared-token', why: '边色取一个没声明的 token（取值退化成空）', body: `${base} border: 2px solid var(--probe-undeclared);` },
      { kind: 'width', why: '边宽归零', body: `${base} border: 0 solid var(--green-2);` },
      { kind: 'style', why: 'border-style 是 none（宽与色都在场也不画）', body: `${base} border: 2px none var(--green-2);` },
      { kind: 'unpinned', why: '只钉两个方向（另外两边按内容收缩）', body: "content: ''; position: absolute; top: 0; left: 0; border: 2px solid var(--green-2);" }
    ]
    for (const { kind, why, body } of survivors) {
      const faults = focusRingFaults([{ selector: '.probe::after', body }], probeTokens)
      expect(
        faults.map((fault) => fault.kind),
        `判据认不出「${why}」应当报 ${kind}——实际报的是：${faults.map((f) => f.why).join(' / ') || '（没有故障）'}`
      ).toContain(kind)
    }
    // 反向：本仓现在的写法必须过，否则这一族退化成恒红，谁碰都红于是被整条删掉。
    expect(
      focusRingFaults([
        { selector: '.probe::after', body: `${base} border: var(--region-focus-ring-width) solid var(--green-2);` }
      ]).map((fault) => fault.why),
      '判据把本仓现在的正确写法也判成故障——它挡的不是坏形状而是所有形状'
    ).toEqual([])
    // 逐边写四条也必须过：判据守的是「四条边都画得出」，不是「必须用简写」。
    expect(
      focusRingFaults([
        {
          selector: '.probe::after',
          body:
            `${base} border-style: solid; border-width: var(--region-focus-ring-width);` +
            ' border-top-color: var(--green-2); border-right-color: var(--green-2);' +
            ' border-bottom-color: var(--green-2); border-left-color: var(--green-2);'
        }
      ]).map((fault) => fault.why),
      '逐边/逐属性写法被误判成故障'
    ).toEqual([])

    // token 展开器自身的在场自检：展不开就等于判据对藏在 token 后的透明色失明（上面那条靠它）。
    const greenValues = resolvedValues('var(--green-2)', TOKENS)
    // 展开结果非空：下面两条（`not.toContain` 与 `every(...)===true`）对空数组都恒成立，
    // 展开器返回空时它们会一起静静放行，而那正是「判据对 token 后的颜色失明」本身。
    expect(greenValues.length, '--green-2 展开成空，下面两条自检都成了空话').toBeGreaterThan(0)
    expect(greenValues, '--green-2 展不开，边色判据只在字面量上有效').not.toContain('var(--green-2)')
    expect(greenValues.every((value) => !isInvisibleColor(value, TOKENS))).toBe(true)
    expect(isInvisibleColor('var(--probe-clear)', probeTokens), '展开器认不出藏在 token 后的 transparent').toBe(true)
  })

  /**
   * 环宽是**一处**：CSS 画它，而进程外的原生视图要按同一个宽度让位。
   *
   * browser 那格的内容是窗口级的原生 `WebContentsView`，合成在**全部** renderer 像素之上——连上面
   * 那个覆盖层也盖不住它。唯一修法是让 `setBounds` 内缩同样的宽度（`nativeBoundsClearOfFocusRing`）。
   * 那个消费者在进程边界之外、读不到 CSS 规则，只能从计算样式取一个自定义属性；于是这个数必须有名字。
   *
   * 这条守的是那个名字两侧都在场：tokens.css 声明它、CSS 用它画、TS 那侧按同一个名字取。任一侧改名
   * 或改成手抄字面量，原生视图就会静默回到满铺（读不出数时按设计返回 0），而两侧行为测试各自全绿。
   */
  it('焦点框宽度只有一处：CSS 与原生视图取值方按同一个自定义属性', () => {
    const PROPERTY = '--region-focus-ring-width'
    expect(styles.match(/--region-focus-ring-width\s*:\s*([^;]+);/)?.[1]).toBe('1px')
    // tokens.css 里声明了它（allStyles 已合并全部样式表）。
    expect(
      new RegExp(`${PROPERTY}\\s*:\\s*[0-9]`).test(styles),
      `${PROPERTY} 没有在样式里声明取值——CSS 侧的环宽会退化成 0（记忆 injected-css-property-declare-default）`
    ).toBe(true)

    // 两个焦点态覆盖层都必须**用**它画，而不是各自写死 2px。
    for (const className of [REGION_FOCUS_CLASS, PANE_GROUP_FOCUS_CLASS]) {
      const overlays = rules().filter((rule) =>
        rule.selector
          .split(',')
          .some((part) => new RegExp(`\\.${className}\\b[^,]*::(?:after|before)`).test(part.trim()))
      )
      const widths = overlays.flatMap((rule) =>
        [...declarations(rule)]
          .filter(([property]) => property === 'border' || property.startsWith('border-'))
          .map(([, value]) => value)
      )
      expect(
        widths.length,
        `.${className} 的覆盖层没有任何 border 声明——那圈框没有可见的边`
      ).toBeGreaterThan(0)
      for (const value of widths) {
        expect(
          value.includes(`var(${PROPERTY}`),
          `.${className} 的覆盖层边宽写着 \`${value}\`，不是从 ${PROPERTY} 取的——` +
            'browser 那格的原生视图按那个属性让位，两边分头写就会静默错开'
        ).toBe(true)
      }
    }

    // 原生视图那一侧按同一个名字取值。判 import 关系不够（导入了不用照样过），所以判它把这个属性名
    // 交给 getPropertyValue——判据落在「取的是哪一个属性」上，这正是上一轮 outline-offset 走错的位置。
    const boundsSource = readFileSync(
      new URL('../src/renderer/src/lib/browser-bounds-sync.ts', import.meta.url),
      'utf8'
    )
    const reads = [...boundsSource.matchAll(/getPropertyValue\(\s*([A-Za-z_$][\w$.]*|'[^']*')/g)]
      .map((match) => match[1]!)
    expect(
      reads.length,
      'getPropertyValue 取值位抽取器一个都没找到——原生视图那侧没有从计算样式读环宽，下面那条是死代码'
    ).toBe(1)
    // 允许经由常量转发（本仓就是 FOCUS_RING_WIDTH_PROPERTY），但那个常量必须绑定到同一个属性名。
    const read = reads[0]!
    const bound = read.startsWith("'")
      ? read.slice(1, -1)
      : new RegExp(`${read}\\s*=\\s*'([^']*)'`).exec(boundsSource)?.[1]
    expect(
      bound,
      `原生视图那侧读的是 \`${read}\`，解析不到它绑定的属性名——取值方与 CSS 侧无法对齐`
    ).toBe(PROPERTY)
  })
})
