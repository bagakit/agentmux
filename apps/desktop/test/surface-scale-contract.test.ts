import { describe, expect, it } from 'vitest'
import { allStyles, stripCssComments, styleFiles } from './helpers/styles.js'

// 守住尺度合同（docs/design/presentation/shared-rules.md《主题与样式 SSOT 规范》）。
//
// 立这道检查之前的实测：16 种字号字面值、32 种间距字面值、330 处非 :root 硬编码颜色，而
// `font-size: var(...)` 出现 **零次**。设计决策全藏在字面值里——改一档字号要靠 grep，改错一处
// 没人发现。更糟的是 `var(--text-1)`、`var(--border-subtle)`、`var(--shadow)` 被引用却从未定义：
// CSS 对悬空变量**静默失效**，所以 Topic 标题那两行的颜色从未生效过，至今无人察觉。
//
// 这道检查从样式表**反推事实**而非核对手工清单：解析全部规则，收集字号、间距与颜色字面值，
// 核对是否落在 token 或已声明的例外清单内。加一个未声明的字面值会红——这正是意图：它要么该用
// token，要么该被论证进合同的例外清单。

// 注释里提到的数值不是规则，先剥掉，否则一句解释性的 "12px" 会被当成声明。
const styles = allStyles().replace(/\/\*[\s\S]*?\*\//g, '')

const rootBlock = styles.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''

/** 合同规定的字号阶梯（px）。选档看这段文字是什么，不看它想显得多大。 */
const FONT_SCALE = new Set([10, 11, 12, 13, 14, 20])

/** 合同规定的间距刻度（px）。4px 基准，2px 半档给紧凑控件内部。 */
const SPACE_SCALE = new Set([2, 4, 6, 8, 12, 16, 24])

/**
 * 字号例外：都不是文字，且尺寸只有一个。
 *
 * 那枚 `?` / `!` 字形随它所在的圆缩放，是图形符号而非可读文本，故不受"不低于 10px"约束。
 * 合同为每一处具名，因为一个不具名的 7px 与一个具名的 7px 在样式表里长得一模一样。
 *
 * 两处载体：状态点内嵌那枚（7px 见方的点），和 Topic 头像右上角那枚角标（8px 见方的圆）。
 * 它们答的是同一个问题，所以尺寸也必须是同一个——见下面 `GLYPH_PX` 那条断言。第一次加进来的
 * 头像角标写的是 6px，理由注释里只解释了它落在哪个角、为什么不用加粗描边，一个字都没说它为什么
 * 比状态点里那枚小 1px：那不是一个决定，是一个没人问过的数。
 */
const GLYPH_PX = 7

const FONT_SIZE_EXCEPTIONS = new Map<string, number>([
  ['.status--error .status__dot::after', GLYPH_PX],
  ['.status--waiting .status__dot::after, .status--blocked .status__dot::after', GLYPH_PX],
])

/**
 * 微字号例外:不走字号阶梯的装饰性字号。与 FONT_SIZE_EXCEPTIONS 分开是因为后者受
 * "一个 glyph 一个尺寸"约束(见 lets that one glyph have exactly one size),那条只允许
 * GLYPH_PX。这里的 9px/10px 是装饰性字号(时间刻度、tooltip 副标题),不在 glyph 面。
 */
const DECORATIVE_FONT_SIZE_EXCEPTIONS = new Map<string, number>([
  // 时间轨道刻度与时间段标签(focus.css)。--fs-micro 是 10px,轨道高 28px 以内的时间标签
  // 用 10px 读起来过大,压过 track 视觉;9px 是刻度美学的下限,与 .activity-ruler__tick 同族
  // (装饰性微值)。同族在 surface-radius-contract 的 MICRO_MARKS 里也豁免了对应 border-radius。
  ['.recent-focus__ruler', 9],
  ['.recent-focus__segment time', 9],
  // surface-navigation tooltip 副标题(agent.css):主标 --fs-body,副标 10px 是"再小一档"
  // 的稳定选择,而 tooltip 是浮层瞬时可见,不参与页面正文字号阶梯。
  ['.surface-navigation__tooltip small', 10],
])

/** Exceptions name the selector, exact property and value that own the geometry. */
const SPACING_EXCEPTIONS = new Map<string, { values: number[]; reason: string }>([
  ['.settings-content|padding-top', { values: [34], reason: 'native titlebar offset' }],
  ['.settings-sidebar|padding-top', { values: [34], reason: 'same native titlebar offset' }],
  ['.settings-search input|padding', { values: [28, 30], reason: 'search and clear icon slots' }],
  ['.board-search input|padding', { values: [28], reason: 'clear icon slot' }],
  ['.browser-selection-result|padding', { values: [44], reason: 'wide reading measure clamp' }],
  ['.activity-feed__empty|padding-top', { values: [70], reason: 'empty state optical centre' }],
  ['.wf-gallery__intro|padding-left', { values: [32], reason: 'absolute 24px section marker slot' }],
  ['.log-row__prose|margin', { values: [104], reason: 'shared activity node and time column alignment' }],
  ['.log-row__payload|margin', { values: [104], reason: 'same activity alignment' }],
  ['.log-row__output|margin', { values: [104], reason: 'same activity alignment' }],
  ['.log-diff|margin', { values: [104], reason: 'same activity alignment' }],
  ['.log-row__chip|padding', { values: [1], reason: 'compact metadata chip optical inset' }],
  ['.browser-profiles__catalog article strong em|padding', { values: [1], reason: 'compact current-profile badge optical inset' }],
  ['.browser-selection-result dl|gap', { values: [1], reason: 'hairline separator between metadata rows' }],
  ['.browser-profiles__browsers label > span|gap', { values: [1], reason: 'compact profile name and location optical separation' }]
])

type Rule = { selector: string; body: string }

function rules(source = styles): Rule[] {
  const out: Rule[] = []
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim().replace(/\s+/g, ' ')
    if (selector.startsWith('@')) continue
    out.push({ selector, body: match[2]! })
  }
  return out
}

type Violation = { selector: string; detail: string }

function fontSizeLiterals(source = styles): Violation[] {
  const out: Violation[] = []
  for (const { selector, body } of rules(source)) {
    for (const declaration of body.matchAll(/(?:^|;)\s*(font-size|font)\s*:\s*([^;]+)/g)) {
      const literals = [...declaration[2]!.matchAll(/(?:^|[\s(,])([\d.]+)px\b/g)]
      // A font shorthand has one size; a later px line-height is a different property.
      for (const match of declaration[1] === 'font' ? literals.slice(0, 1) : literals) {
        const px = Number(match[1])
        if (FONT_SIZE_EXCEPTIONS.get(selector) === px) continue
        if (DECORATIVE_FONT_SIZE_EXCEPTIONS.get(selector) === px) continue
        out.push({ selector, detail: `${declaration[1]}: ${px}px ${FONT_SCALE.has(px) ? '应写作 var(--fs-…)' : '不在字号阶梯内'}` })
      }
    }
  }
  return out
}

const SPACING_PROPERTIES = /(?:^|;)\s*((?:gap|row-gap|column-gap|padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?)\s*:\s*([^;]+)/g

function spacingLiterals(source = styles): Violation[] {
  const out: Violation[] = []
  for (const { selector, body } of rules(source)) {
    for (const declaration of body.matchAll(SPACING_PROPERTIES)) {
      const property = declaration[1]!
      for (const raw of declaration[2]!.matchAll(/(-?[\d.]+)px\b/g)) {
        const px = Number(raw[1])
        if (px === 0) continue
        if (SPACING_EXCEPTIONS.get(`${selector}|${property}`)?.values.includes(px)) continue
        out.push({ selector, detail: `${property}: ${px}px ${SPACE_SCALE.has(px) ? '应写作 var(--sp-…)' : '不在间距刻度内'}` })
      }
    }
  }
  return out
}

/**
 * 非 :root 区域的裸 hex。token 之外的颜色不该在这里被手调出来。
 *
 * `color-mix()` 里的纯白与纯黑不算——它们是**配料**而非界面色：`color-mix(… var(--green) 88%, #ffffff)`
 * 表达的是"把这个 token 提亮"，那是一个从 token 派生的关系，正是本合同想要的写法。为它造一个
 * `--white` token 只会让同一件事多绕一层。
 */
function colorLiterals(source = styles): Violation[] {
  const out: Violation[] = []
  for (const { selector, body } of rules(source)) {
    if (selector === ':root') continue
    // 先摘掉 color-mix(...) 里的纯白/纯黑配料，剩下的才是真的手调颜色。
    // 内层可能还有 var(...)，所以放行一层嵌套括号。
    const scrubbed = body.replace(
      /color-mix\((?:[^()]|\([^()]*\))*\)/g,
      (mix) => mix.replace(/#(?:fff|ffffff|000|000000)\b/gi, 'mix-base')
    )
    for (const match of scrubbed.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/gi)) {
      out.push({ selector, detail: `裸颜色 ${match[0]}` })
    }
  }
  return out
}

/** 被 var() 引用却无人定义的变量。CSS 不报错，所以这里必须报。 */
function danglingVariables(source = styles): string[] {
  const defined = new Set([...source.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!))
  const dangling = new Set<string>()
  for (const match of source.matchAll(/var\((--[a-z0-9-]+)/g)) {
    const name = match[1]!
    // Radix 在运行时注入自己的变量，样式表里定义不到它们。
    if (name.startsWith('--radix-')) continue
    // 组件用 inline `style={{ '--x': ... }}` 从 JS 侧注入几何/运行时值——样式表里没有 `:` 定义，
    // 但也没漂空:值总来自组件 state。同 Radix 一样,不算 dangling。豁免清单必须点名而不是宽泛
    // 前缀,免得未来一个漏定义的 token 溜进"看着像 inline"这条洞里。每加一条,注明注入点。
    if (RUNTIME_INJECTED_VARS.has(name)) continue
    if (!defined.has(name)) dangling.add(name)
  }
  return [...dangling].sort()
}

// 由 JS 侧组件通过 inline style 注入的 CSS 变量清单。每项都必须能点到一处 `style={{ '--x': ... }}`
// 或等价的运行时 setProperty 调用,否则应该是真 dangling(视作 bug 由主判据打红)。
const RUNTIME_INJECTED_VARS = new Set([
  // GlobalFocusSurface.tsx: workspace 分屏比例,由 pointer/keyboard 手柄拖出来,inline 注入到
  // `.global-focus-layout` 元素上,焦点面板与工作区通过 `var(--focus-workspace-width, ...)` 读它。
  // 缺省值写在 fallback 里,所以缺席时也不炸。
  '--focus-workspace-width'
])

describe('surface scale contract', () => {
  it('reads real declarations out of the sheet, so the checks below can actually fail', () => {
    // 扫不到东西的检查会全绿地什么也不说——先证明扫描本身有效。
    expect(rules().length).toBeGreaterThan(100)
    expect(styles).toMatch(/font-size:/)
  })

  it('defines the six-step font scale and the spacing scale in :root', () => {
    for (const token of ['--fs-micro', '--fs-meta', '--fs-body', '--fs-prose', '--fs-title', '--fs-display']) {
      expect(rootBlock).toContain(`${token}:`)
    }
    for (const token of ['--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--sp-6', '--sp-7', '--sp-8']) {
      expect(rootBlock).toContain(`${token}:`)
    }
    // 例外清单是相对这两档判定的；下限漂了，"不低于 10px"这句话就换了意思。
    expect(rootBlock).toMatch(/--fs-micro:\s*10px/)
    expect(rootBlock).toMatch(/--sp-4:\s*8px/)
  })

  it('defines no token nothing uses', () => {
    // 合同要求"定义了却无人引用的 token 一律删除，不留以后可能用得上"。一个没有落点的 token
    // 比没有更糟：它让下一个人以为这里已经有答案了。
    const declared = [...rootBlock.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!)
    const unused = declared.filter((token) => !styles.includes(`var(${token})`))
    expect(unused).toEqual([])
  })

  it('derives the status colour families from their base tokens', () => {
    // 三件套（浅文字 / 深底 / 中边框）此前是手调出来的三十多个近似 hex，调基色传导不到任何一处。
    // 用 color-mix 从基色派生，是为了让"调 --red 等于调整整个危险语汇"这句话真的成立——
    // 所以派生关系本身要被守住，写死成 hex 就等于回到原点。
    for (const family of ['red', 'green', 'amber']) {
      for (const tier of ['text', 'bg', 'line']) {
        expect(rootBlock).toMatch(
          new RegExp(`--${family}-${tier}:\\s*color-mix\\([^;]*var\\(--${family}\\)`)
        )
      }
    }
  })

  it('never references a variable nothing defines', () => {
    // 悬空引用是静默失效的 bug，不是笔误：那条声明从未生效，而 CSS 一声不吭。
    expect(danglingVariables()).toEqual([])
  })

  it('spends every font size through the scale', () => {
    expect(fontSizeLiterals().map((v) => `${v.selector} { ${v.detail} }`)).toEqual([])
  })

  it('spends every spacing value through the scale', () => {
    expect(spacingLiterals().map((v) => `${v.selector} { ${v.detail} }`)).toEqual([])
  })

  it('keeps colour in tokens instead of hand-tuned hex', () => {
    expect(colorLiterals().map((v) => `${v.selector} { ${v.detail} }`)).toEqual([])
  })

  it('names its exceptions instead of leaving holes', () => {
    // 例外必须指向真实存在的选择器，否则清单会随着重命名悄悄失效，留下一个谁都能钻的洞。
    const selectors = new Set(rules().map((rule) => rule.selector))
    for (const selector of FONT_SIZE_EXCEPTIONS.keys()) {
      expect(selectors).toContain(selector)
    }
    for (const [key, exception] of SPACING_EXCEPTIONS) {
      expect(selectors).toContain(key.split('|')[0])
      expect(exception.reason.length).toBeGreaterThan(0)
      expect(exception.values.length).toBeGreaterThan(0)
    }
  })

  it('lets that one glyph have exactly one size, however many places carry it', () => {
    // 字号例外表现在有两条，而多一条例外就是多一个可以各挑一个数的地方。这枚 `?` / `!` 在状态点里
    // 和头像角标上答的是同一个问题（"有人在等你" / "这坏了"），所以它的尺寸是**一个**决定：
    // 两处各写一个数，就是同一件事在两个面板上读起来略有不同，而没有任何人会注意到差在哪。
    //
    // 判据是恒等而不是"都在例外表里"：后者对 6px 和 7px 一视同仁——它就是这条断言之前的样子，
    // 而 6px 正是那时加进来的。
    expect([...FONT_SIZE_EXCEPTIONS.values()]).toEqual(
      [...FONT_SIZE_EXCEPTIONS.keys()].map(() => GLYPH_PX)
    )
    // 自检：例外表真的有多于一处载体，否则上面那条恒等是在一个单元素集合上成立的空话。
    expect(FONT_SIZE_EXCEPTIONS.size).toBeGreaterThan(1)
    // 而每一处都必须真的在画那枚字形——一条不带 `content` 的例外是在拿这条豁免做别的事。
    const bodies = new Map(rules().map((rule) => [rule.selector, rule.body]))
    for (const selector of FONT_SIZE_EXCEPTIONS.keys()) {
      expect(bodies.get(selector), `${selector} 不画字形，却用了"这不是文字"的豁免`).toMatch(
        /content:\s*['"][^'"]+['"]/u
      )
    }
  })

  it('keeps the agent catalog inside its own box instead of growing the launcher', () => {
    // 密度合同（Agent Provider Catalog 一行）要求这个容器**自己**有界、自己滚。此前它只有 margin：
    // 11 个 Agent 摊成三行，把下方的 prompt 输入框顶出视口——启动页第一眼看不到输入框。
    // 判据是"有没有这两个属性"而不是"268 是不是 268"：把数抄进测试，数就活在两个地方，改一处就漂。
    const body = new Map(rules().map((rule) => [rule.selector, rule.body])).get('.agent-catalog')
    expect(body, '.agent-catalog 这条规则不在样式表里，下面两条断言等于没跑').toBeDefined()
    expect(body, '.agent-catalog 没有高度上界，Agent 一多就把 prompt 顶下屏').toMatch(/max-height:/)
    expect(body, '.agent-catalog 不自己滚，溢出会转嫁给整个 launcher').toMatch(/overflow(-y)?:/)
  })

  it('limits each geometry exception to its exact selector and property', () => {
    expect(spacingLiterals('.log-row__payload { margin: 0 104px; }')).toEqual([])
    expect(spacingLiterals('.another { margin: 0 104px; }')).toHaveLength(1)
    expect(spacingLiterals('.log-row__payload { padding: 104px; }')).toHaveLength(1)
    expect(spacingLiterals('.another { gap: 3px; }')).toHaveLength(1)
    expect(spacingLiterals('.another { padding-inline-start: 6px; }')).toHaveLength(1)
  })

  it('detects font shorthand and rgb status recipes with the real scanners', () => {
    expect(fontSizeLiterals('.readable { font: 600 11px/1.5 sans-serif; }')).toHaveLength(1)
    expect(fontSizeLiterals('.readable { font: var(--fs-meta)/16px sans-serif; }')).toEqual([])
    expect(fontSizeLiterals('.readable { font-size: clamp(10px, 1vw, 12px); }')).toHaveLength(2)
    expect(colorLiterals('.state { background: rgba(102,187,125,.12); color: rgb(1 2 3); }')).toHaveLength(2)
    expect(colorLiterals('.state { background: var(--green-bg); color: color-mix(in srgb, var(--green) 90%, #ffffff); }')).toEqual([])
  })

  it('keeps the repaired consumers on existing scales and status families', () => {
    const files = styleFiles().filter(file => ['settings-toolkit.css', 'browser.css'].includes(file.name))
    expect(files).toHaveLength(2)
    const selected = files.flatMap(file => rules(stripCssComments(file.text))).concat(
      rules().filter(({ selector }) => selector === '.focus-navigation-preview__identity .focus-navigation-preview__viewing' || selector === '.focus-location-choice strong')
    )
    expect(selected.length).toBeGreaterThan(10)
    const source = selected.map(({ selector, body }) => `${selector} { ${body} }`).join('\n')
    expect(fontSizeLiterals(source)).toEqual([])
    const statusSource = selected.filter(({ selector }) => selector.includes('.toolkit-') || selector.includes('.browser-profiles')).map(({ selector, body }) => `${selector} { ${body} }`).join('\n')
    expect(statusSource.length).toBeGreaterThan(0)
    expect(colorLiterals(statusSource)).toEqual([])
    const definitions = rules().filter(({ body }) => /--[\w-]+\s*:/.test(body))
    expect(definitions.length).toBeGreaterThan(0)
    expect(danglingVariables(definitions.map(({ selector, body }) => `${selector} { ${body} }`).join('\n') + source)).toEqual([])
    expect(spacingLiterals(source).filter(({ selector }) => selector.startsWith('.toolkit-') || selector.startsWith('.browser-profiles'))).toEqual([])
  })
})
