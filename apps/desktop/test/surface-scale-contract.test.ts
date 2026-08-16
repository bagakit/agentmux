import { describe, expect, it } from 'vitest'
import { allStyles } from './helpers/styles.js'

// 守住尺度合同（docs/design/agentmux-surface-density.md《尺度系统》）。
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
 * 间距例外：刻度外的值必须有理由，且理由要能一句话说清。
 *
 * 1px 是 hairline 的物理下限，不是间距选择；104px 是 Activity 展开内容与其标题的对齐点，
 * 由 20px 节点槽 + 56px 时间槽 + padding 累加而来，改成 96 或 112 会让对齐失效。
 */
const SPACING_EXCEPTIONS = new Set([1, 104])

/**
 * 布局尺寸例外：这些大值不是节奏，是几何。
 *
 * 刻度管的是"元素之间隔多远"，它到 24px 为止；再往上的值全都在回答别的问题——给红绿灯让出多宽、
 * 输入框右侧的图标占几像素、`clamp()` 在大屏上的上界是多少。把它们塞进刻度会让刻度失去含义
 * （一个有 80px 的"节奏刻度"约束不了任何东西），所以按**选择器**具名放行，而不是把数值加进白名单——
 * 数值白名单一旦放开 30px，全表任何地方都能写 30px。
 */
const LAYOUT_GEOMETRY = new Map<string, string>([
  ['.sidebar-toggle-chrome', '左侧 80px 给 macOS 红绿灯让位'],
  ['.settings-content', '34px 顶栏偏移，与 .settings-sidebar 对齐'],
  ['.settings-sidebar', '34px 顶栏偏移，与 .settings-content 对齐'],
  ['.settings-content > header', '25px 光学垂直居中；clamp 上界 74px 是大屏阅读宽度'],
  ['.settings-content__scroll', 'clamp 上界 74px 与 header 同宽；底部 50px 是滚动尾部留白'],
  ['.settings-search input', '右 28px / 左 30px 给搜索与清除图标让位'],
  ['.board-search input', '右 28px 给清除按钮让位'],
  ['.launch-surface', 'clamp 上界 60px 是大屏阅读宽度；底部 44px 给 composer 让位'],
  ['.browser-selection-result', 'clamp 上界 44px 是大屏阅读宽度'],
  ['.activity-feed__empty', '70px 让空态在视觉中心而非几何中心'],
  ['.wf-gallery__intro', '左 32px 给绝对定位的 24px 章节标记让位']
])


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

type Violation = { selector: string; detail: string }

function fontSizeLiterals(): Violation[] {
  const out: Violation[] = []
  for (const { selector, body } of rules()) {
    for (const match of body.matchAll(/font-size:\s*([\d.]+)px/g)) {
      const px = Number(match[1])
      if (FONT_SIZE_EXCEPTIONS.get(selector) === px) continue
      if (FONT_SCALE.has(px)) {
        // 值对了但没走 token——改 token 时这一处不会跟着动，等于没收进来。
        out.push({ selector, detail: `font-size: ${px}px 应写作 var(--fs-…)` })
        continue
      }
      out.push({ selector, detail: `font-size: ${px}px 不在字号阶梯内` })
    }
  }
  return out
}

const SPACING_PROPERTIES = /(?:^|;|\s)(gap|row-gap|column-gap|padding|margin)(?:-(?:top|right|bottom|left|inline|block))?:\s*([^;]+)/g

function spacingLiterals(): Violation[] {
  const out: Violation[] = []
  for (const { selector, body } of rules()) {
    for (const declaration of body.matchAll(SPACING_PROPERTIES)) {
      const property = declaration[1]!
      for (const raw of declaration[2]!.matchAll(/(\d+)px/g)) {
        const px = Number(raw[1])
        if (SPACING_EXCEPTIONS.has(px)) continue
        // 超出刻度上限的是布局几何，按选择器放行——数值一旦进白名单，全表哪里都能写它。
        if (px > 24 && LAYOUT_GEOMETRY.has(selector)) continue
        if (SPACE_SCALE.has(px)) {
          out.push({ selector, detail: `${property}: ${px}px 应写作 var(--sp-…)` })
          continue
        }
        out.push({ selector, detail: `${property}: ${px}px 不在间距刻度内` })
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
function colorLiterals(): Violation[] {
  const out: Violation[] = []
  for (const { selector, body } of rules()) {
    if (selector === ':root') continue
    // 先摘掉 color-mix(...) 里的纯白/纯黑配料，剩下的才是真的手调颜色。
    // 内层可能还有 var(...)，所以放行一层嵌套括号。
    const scrubbed = body.replace(
      /color-mix\((?:[^()]|\([^()]*\))*\)/g,
      (mix) => mix.replace(/#(?:fff|ffffff|000|000000)\b/gi, 'mix-base')
    )
    for (const match of scrubbed.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      out.push({ selector, detail: `裸颜色 ${match[0]}` })
    }
  }
  return out
}

/** 被 var() 引用却无人定义的变量。CSS 不报错，所以这里必须报。 */
function danglingVariables(): string[] {
  const defined = new Set([...styles.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!))
  const dangling = new Set<string>()
  for (const match of styles.matchAll(/var\((--[a-z0-9-]+)/g)) {
    const name = match[1]!
    // Radix 在运行时注入自己的变量，样式表里定义不到它们。
    if (name.startsWith('--radix-')) continue
    if (!defined.has(name)) dangling.add(name)
  }
  return [...dangling].sort()
}

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
    for (const selector of LAYOUT_GEOMETRY.keys()) {
      expect(selectors).toContain(selector)
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

  it('lets a layout exception excuse only the large values, never the scale itself', () => {
    // 一个具名了布局几何的选择器，它的常规间距仍要走刻度——否则"具名一次，全屏放开"。
    const excused: Violation[] = []
    for (const { selector, body } of rules()) {
      if (!LAYOUT_GEOMETRY.has(selector)) continue
      for (const declaration of body.matchAll(SPACING_PROPERTIES)) {
        for (const raw of declaration[2]!.matchAll(/(\d+)px/g)) {
          const px = Number(raw[1])
          if (px > 24 || SPACING_EXCEPTIONS.has(px)) continue
          excused.push({ selector, detail: `${declaration[1]}: ${px}px` })
        }
      }
    }
    expect(excused.map((v) => `${v.selector} { ${v.detail} }`)).toEqual([])
  })
})
