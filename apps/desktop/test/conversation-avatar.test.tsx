import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConversationSpeakerAvatar } from '../src/renderer/src/components/ConversationSpeakerAvatar.js'
import { speakerColorHue } from '../src/renderer/src/lib/conversation-avatar-color.js'
import { HUMAN_SPEAKER_ID } from '../src/renderer/src/lib/conversation-speaker.js'

/**
 * 说话人头像组件的验收。
 *
 * 这一栈里 effect / timer 不跑（renderToStaticMarkup 只求一次同步元素树），所以每条断言都落在
 * **标记**或**纯函数**上，绝不落在注册的 handler 上——否则断言看起来过了、其实什么都没守住。
 * 四条验收各自对应下面一个 describe；每条断言的注释都写清「删掉这行断言、或把实现改坏，会漏掉什么」。
 */

// 把组件渲染成静态标记。组件是纯的（验收 1），因此无需 DOM、无需 mount，直接求值即可。
function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node)
}

describe('说话人头像：颜色由身份 id 确定性派生（验收 2）', () => {
  it('同一 id 任意次调用得同一个色相——身份色不随渲染次数/顺序变', () => {
    // 设计明确禁止「按渲染顺序取色」。这条断言钉住确定性：把 speakerColorHue 改成读 Math.random /
    // 读计数器，这里立刻红。等式两边是同一次输入的两次独立调用，纯函数必然相等。
    expect(speakerColorHue('agent-abc')).toBe(speakerColorHue('agent-abc'))
    expect(speakerColorHue(HUMAN_SPEAKER_ID)).toBe(speakerColorHue(HUMAN_SPEAKER_ID))
  })

  it('一批相邻 id 全都散得开，不只是抽查的那一对——塌成两簇也要红', () => {
    // 这条补的是一个实测存在的洞：下一条只探了 agent-1 / agent-2 这**一对**，而把 avalanche 那一步
    // 删掉（只留 FNV-1a 的 `hash % 360`）时**9 条全绿**。原因是 FNV-1a 对末字节递增的输入产出等差
    // 数列，8 个 id 会塌成两簇——实测 agent-1..8 得 64,241,62,239,60,237,58,235：奇数号挤在 58–64、
    // 偶数号挤在 235–241，四个 Agent 互相只差 2 度。而恰好 agent-1 与 agent-2 分属两簇、差 177 度，
    // 于是抽查那一对反而是**唯一**看不出问题的取样。断言粒度比 bug 更粗，这就是那个形态。
    //
    // 所以这里不抽查，而是要求整批**两两**都拉开。阈值取 12 度：低于这个数在固定 S/L 的柔和带里
    // 已经是同色（同一批实测里 agent-1 与 agent-8 差 3 度，肉眼同色——那是散列的固有性质，可分性
    // 由形状与 aria-label 承担，见文件末尾兜底那条；但**一整簇**都挤在几度内是另一回事：那说明
    // 派生根本没在做扩散）。要求全部两两 ≥12 度会被 3 度那对否掉，所以判据落在"最近邻的中位数"：
    // 塌成两簇时中位最近邻 ≈2 度，健康时 ≈45 度，两者相差一个数量级，阈值放哪都分得开。
    const hues = Array.from({ length: 8 }, (_, i) => speakerColorHue(`agent-${i + 1}`))
    const nearest = hues.map((h, i) =>
      Math.min(...hues.filter((_, j) => j !== i).map((o) => Math.min(Math.abs(h - o), 360 - Math.abs(h - o))))
    )
    const median = [...nearest].sort((a, b) => a - b)[Math.floor(nearest.length / 2)]!
    expect(median).toBeGreaterThan(12)
  })

  it('不同 id 派生出能区分的色相——相邻 id 也不许挤在一度之内', () => {
    // 这是「不同 id 要能区分」的核心，也是变异 (a) 的靶子：把派生换成常量，两个不同 id 会拿到
    // 同一个色相，下面第一条断言就报「两个不同 id 得到了同色」。相邻 id（只差一个字节）尤其危险，
    // 朴素字符和会让它们只差一两度、肉眼分不开，所以专门拿 agent-1 / agent-2 当探针。
    expect(speakerColorHue('agent-1')).not.toBe(speakerColorHue('agent-2'))
    expect(speakerColorHue('claude-session-01')).not.toBe(speakerColorHue('codex-session-01'))
    // 值域必须落在合法色相环内，否则 CSS 的 hsl() 会把越界值 clamp 成同一端点、又撞回同色。
    for (const id of ['agent-1', 'agent-2', 'a', 'zzzzzzzz', HUMAN_SPEAKER_ID]) {
      const hue = speakerColorHue(id)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })

  it('两个 Agent 头像把各自的 id 色相写进标记——同一条对话里的两个 Agent 因此可分', () => {
    // 组件层复核变异 (a)：即便派生函数本身没被换成常量，如果组件忘了把 speaker.id 喂进派生、
    // 或把色相写死，两枚头像的 --speaker-hue 就会相同。这里比较的是渲染出来的内联样式。
    const one = render(
      <ConversationSpeakerAvatar speaker={{ role: 'agent', id: 'agent-1' }} name="Claude" providerId="claude" />
    )
    const two = render(
      <ConversationSpeakerAvatar speaker={{ role: 'agent', id: 'agent-2' }} name="Claude" providerId="claude" />
    )
    const hueOf = (markup: string) => /--speaker-hue:\s*([0-9]+)/.exec(markup)?.[1]
    expect(hueOf(one)).toBeDefined()
    expect(hueOf(two)).toBeDefined()
    expect(hueOf(one)).not.toBe(hueOf(two))
  })
})

describe('说话人头像：无障碍（验收 3）', () => {
  it('装饰性 glyph 带 aria-hidden——读屏不会把一个无名图标读出来', () => {
    // 变异 (b) 的靶子：human 的 UserRound 是纯装饰（身份靠外层 aria-label 提供），必须 aria-hidden。
    // 外层 span 是 role="img" 而**不**带 aria-hidden，所以整段标记里出现 aria-hidden 只可能来自内部
    // glyph——删掉 glyph 上的 aria-hidden，下面断言立刻红。
    const human = render(
      <ConversationSpeakerAvatar speaker={{ role: 'human', id: HUMAN_SPEAKER_ID }} name="You" />
    )
    expect(human).toContain('aria-hidden="true"')
    // 且 aria-hidden 挂在 svg（glyph）上，不是挂在外层——否则整个头像会对读屏消失，身份名也没了。
    expect(/<svg[^>]*aria-hidden="true"/.test(human)).toBe(true)
  })

  it('身份名以 aria-label 提供——不存在只有视觉才能获得的身份信息', () => {
    // 变异 (c) 的靶子：去掉 aria-label（或不接收 name），颜色/形状就成了唯一的身份载体，读屏用户
    // 只能听到「图形」。这里钉住可访问名等于调用方传入的 name。
    const human = render(
      <ConversationSpeakerAvatar speaker={{ role: 'human', id: HUMAN_SPEAKER_ID }} name="You" />
    )
    const agent = render(
      <ConversationSpeakerAvatar speaker={{ role: 'agent', id: 'agent-1' }} name="Claude" providerId="claude" />
    )
    expect(human).toContain('aria-label="You"')
    expect(agent).toContain('aria-label="Claude"')
    // role="img" 让 aria-label 真正成为这个元素的可访问名（否则 label 挂在一个无语义 span 上会被忽略）。
    expect(human).toContain('role="img"')
  })
})

describe('说话人头像：两个尺寸都可用（验收 4）', () => {
  it('16px 与 20px 都把尺寸写进外框——不是只为一个尺寸调过', () => {
    // 变异 (d) 的靶子：把 size 写死成某一个值，另一个尺寸的渲染就不会跟着变。这里分别在 16 与 20
    // 渲染，各自断言外框 width/height 等于该尺寸——写死任一值，另一条立刻红。
    const small = render(
      <ConversationSpeakerAvatar speaker={{ role: 'agent', id: 'agent-1' }} name="Claude" providerId="claude" size={16} />
    )
    const large = render(
      <ConversationSpeakerAvatar speaker={{ role: 'agent', id: 'agent-1' }} name="Claude" providerId="claude" size={20} />
    )
    expect(small).toContain('width:16px')
    expect(small).toContain('height:16px')
    expect(large).toContain('width:20px')
    expect(large).toContain('height:20px')
  })

  it('内部 glyph 随尺寸内缩——两个尺寸下 glyph 边长不同且都非零', () => {
    // 尺寸如果只作用在外框、glyph 却恒定，大尺寸下 glyph 会显小、留白失衡；写死 size 也会让两次
    // glyph 尺寸相同。断言两次渲染的 svg 边长不同，且都 >= 8（下限钳制，避免极小尺寸 glyph 归零）。
    const small = render(
      <ConversationSpeakerAvatar speaker={{ role: 'human', id: HUMAN_SPEAKER_ID }} name="You" size={16} />
    )
    const large = render(
      <ConversationSpeakerAvatar speaker={{ role: 'human', id: HUMAN_SPEAKER_ID }} name="You" size={20} />
    )
    const svgWidth = (markup: string) => Number(/<svg[^>]*\bwidth="([0-9]+)"/.exec(markup)?.[1])
    expect(svgWidth(small)).toBeGreaterThanOrEqual(8)
    expect(svgWidth(large)).toBeGreaterThanOrEqual(8)
    expect(svgWidth(small)).not.toBe(svgWidth(large))
    // 上面三条只说了"两个尺寸下 glyph 不同且非零"，**没说它比外框小**：把内缩改成 `glyphSize = size`
    // 时它们仍全绿（实测）。而 glyph 等于外框意味着圆片没有边距、图形贴着圆边被裁——圆片形态就没了。
    // 所以这里钉住内缩本身：glyph 严格小于外框，且留白不超过外框的一半（否则 glyph 缩到看不清）。
    expect(svgWidth(small)).toBeLessThan(16)
    expect(svgWidth(large)).toBeLessThan(20)
    expect(svgWidth(large)).toBeGreaterThan(10)
  })
})

describe('说话人头像：受控纯组件（验收 1）', () => {
  it('props 进、元素树出——无 DOM 也能直接求值，且按 role 分叉画法', () => {
    // 验收 1 的可观测证据：整个测试文件都在无 DOM 环境里用 renderToStaticMarkup 求值，能跑通本身
    // 就说明组件不读 Store、不 import api、不依赖挂载。这里再钉住 role 决定 className 分叉：human
    // 与 agent 各拿到自己的修饰类，CSS 才能分别上色（见 conversation-avatar.css）。
    const human = render(
      <ConversationSpeakerAvatar speaker={{ role: 'human', id: HUMAN_SPEAKER_ID }} name="You" />
    )
    const agent = render(
      <ConversationSpeakerAvatar speaker={{ role: 'agent', id: 'agent-1' }} name="Claude" providerId="claude" />
    )
    expect(human).toContain('conversation-avatar--human')
    expect(agent).toContain('conversation-avatar--agent')
  })

  it('providerId 查不到时仍画出一枚有名有形的头像——不留空洞也不掉可访问名', () => {
    // `providerId` 是 optional，而 T-004 是「用 speaker.id 去 store 查 providerId」再传进来的：
    // Session 已退场、store 尚未装载、或那条 item 的 Agent 已被清理时，查不到就是常态而非异常。
    // 上面每一条 agent 断言都传了 providerId="claude"，所以**兜底这条路从来没被测过**——而它恰好是
    // 传参出错时唯一的安全网。
    //
    // 兜底必须同时守住三件事，缺一件这枚标记就变成轴上一个无法解释的空位：
    // 有 glyph（AgentProviderIcon 的 default 分支给 Bot）、有可访问名、身份色仍按 id 派生。
    const fallback = render(
      <ConversationSpeakerAvatar speaker={{ role: 'agent', id: 'agent-orphan' }} name="Unknown agent" />
    )
    expect(fallback).toContain('<svg')
    expect(fallback).toContain('aria-label="Unknown agent"')
    expect(fallback).toMatch(/--speaker-hue:\s*[0-9]+/)
    // 而且它仍然是 agent 那一路的画法——不许因为查不到 provider 就退化成人形剪影。
    expect(fallback).toContain('conversation-avatar--agent')
  })
})
