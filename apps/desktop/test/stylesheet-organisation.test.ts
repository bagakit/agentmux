import { describe, expect, it } from 'vitest'
import { clearsSemanticHues } from '../src/renderer/src/lib/conversation-avatar-color.js'
import { allStyles, styleFiles } from './helpers/styles.js'

/**
 * 样式表按表面分文件。
 *
 * 2551 行的单文件不是"文件大"的问题，是**找不到东西**的问题：改 Topic 行要先 grep 出它散在
 * 哪几段，改完不知道有没有漏。这里守住拆分之后的形状——尤其是那些一旦破了就悄悄破、
 * 不会有任何行为测试变红的约束。
 */
describe('样式表的组织', () => {
  it('每个表面一个文件，入口按顺序 @import——层叠顺序即文件顺序', () => {
    const files = styleFiles().map((file) => file.name)
    expect(files).toEqual([
      'tokens.css',
      'base.css',
      'chrome.css',
      'selector.css',
      'dock.css',
      'source-control.css',
      'workbench.css',
      'terminal.css',
      'surfaces.css',
      'board.css',
      'browser.css',
      'agent.css',
      'composer.css',
      'activity.css',
      'activity-conversation.css',
      'conversation-avatar.css',
      'conversation-axis.css',
      'overlays.css'
    ])
  })

  it(':root 只有一处，在 tokens.css', () => {
    // 第二个 :root 会让"尺度系统有唯一来源"这句话失效，且两处定义谁赢取决于 @import 顺序——
    // 一个没人会去读的规则决定了全表的颜色。
    for (const { name, text } of styleFiles()) {
      const count = text.split(':root').length - 1
      if (name === 'tokens.css') expect(count).toBeGreaterThan(0)
      else expect(`${name}: ${count} 处 :root`).toBe(`${name}: 0 处 :root`)
    }
    expect(allStyles().split(':root {').length - 1).toBe(1)
  })

  it('单文件不超过 400 行——超出的按表面继续拆，不靠注释分节假装分层', () => {
    const oversized = styleFiles()
      .map(({ name, text }) => ({ name, lines: text.split('\n').length }))
      .filter(({ lines }) => lines > 400)
    expect(oversized.map(({ name, lines }) => `${name} 有 ${lines} 行`)).toEqual([])
  })

  it('没有孤儿文件：每个样式文件都被入口 @import', () => {
    // styleFiles() 自身会在发现未被 @import 的文件时抛错——一个没进入口的样式文件是死文件，
    // 它的规则永不生效，而契约测试会照常扫描它并放行。这里把那条检查变成一条显式断言。
    expect(() => styleFiles()).not.toThrow()
    expect(styleFiles().length).toBeGreaterThan(1)
  })

  it('没有被浏览器静默丢弃的声明——`-var(...)` 不是合法 CSS', () => {
    // 这条守的是一整类**不会有任何东西变红**的错误：写 `margin-top:-var(--sp-2)` 想表达"负一个
    // 尺度令牌"，但 CSS 里减号不能这样前置到 var() 上，整条声明会被解析器直接丢掉——没有控制台
    // 报错、没有 lint、没有行为测试会红，页面只是悄悄少了一条规则。
    //
    // 实测过一次真实后果：`.activity-ruler__tick`/`__band` 用 `top:50%` + 负 margin-top 做垂直
    // 居中，声明被丢弃后负 margin 归零，每根 tick 都比中线低半个身位。全表当时有 7 处。
    //
    // 正确写法是 `calc(-1 * var(--sp-N))`，或者干脆用不依赖高度的 `translate` 做居中。这条断言
    // 报出每一处的文件与行号，因为一处一处地找是这类 bug 唯一的排查方式。
    const offenders: string[] = []
    for (const { name, text } of styleFiles()) {
      // 注释里出现 `-var(` 通常正是在**告诫**别这么写（selector.css 就有一句），那不是声明，
      // 报出来会把一句正确的提醒变成红灯。所以先剥注释，只在真声明上找。剥注释也顺带避免
      // 「注释里写了个反例」与「代码里真写错」在报告里长得一样。
      const code = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      code.split('\n').forEach((line, index) => {
        // 只找减号紧贴 var( 的写法。`calc(-1 * var(...))` 与 `--custom-prop: value` 都不匹配。
        if (/(?<![\w)])-var\(/.test(line)) offenders.push(`${name}:${index + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('共用坐标框的承重声明——删掉它们不会报错，只会让两条轴悄悄与刻度错位', () => {
    // 这条守的是一类**没有任何可见报错**的失效。`.activity-ruler__stack` 是接替 `__track` 当 ruler
    // 行 flex 子项的那个元素（见 conversation-axis.css 的文件头），所以它必须继承 `flex: 1`：少了
    // 它，stack 收缩成内容宽度，每枚标记的 `left: N%` 又回到一个更窄的盒子上算——正是这个 stack
    // 存在要消掉的那个漂移。页面不报错、不空白，只是轴与刻度不再对齐，而对齐是这两条轴存在的
    // 全部理由。
    //
    // 渲染层那侧已经有断言（activity-view.test.tsx 判 stack/轴/track 的嵌套结构），但结构对了、
    // 声明被删掉，那条仍然全绿——本仓没有能跑布局的测试环境，所以这三条只有在样式表上判。
    // 落点选这个文件而不是渲染测试：读 CSS 这件事集中在契约测试里，渲染测试不碰文件系统。
    const files = new Map(styleFiles().map((file) => [file.name, file.text]))
    const axisCss = files.get('conversation-axis.css')
    expect(axisCss, 'conversation-axis.css 不在 @import 列表里了').toBeDefined()

    const ruleOf = (selector: string): string => {
      const escaped = selector.replace(/[.[\]]/g, '\\$&')
      const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(axisCss!)
      expect(match, `${selector} 的规则不见了`).not.toBeNull()
      return match![1]!
    }

    // 共用盒：必须占满 ruler 行的剩余宽度，且纵向排布（三行叠起来才谈得上"同一列"）。
    const stack = ruleOf('.activity-ruler__stack')
    expect(stack).toMatch(/flex:\s*1\b/)
    expect(stack).toMatch(/flex-direction:\s*column/)
    // 每条轴：它是每枚标记 `left: N%` 解析的那个包含块，所以必须自己建立定位上下文；高度要与组件
    // 传下去的头像边长（16）相等——短了裁掉头像，高了在 ruler 上方加一条死白。
    const axis = ruleOf('.conversation-axis')
    expect(axis).toMatch(/position:\s*relative/)
    expect(axis).toMatch(/height:\s*16px/)
    // 标记：`translate(-50%, -50%)` 的两半各有承重理由——横向把中心（而非左边缘）拉到它所指的刻度
    // 上，纵向让命中区能在不移动头像的前提下变大。少任何一半都会让整条轴系统性偏移半个头像。
    const mark = ruleOf('.conversation-axis__mark')
    expect(mark).toMatch(/position:\s*absolute/)
    expect(mark).toMatch(/transform:\s*translate\(-50%,\s*-50%\)/)
  })

  it('身份色的 CSS 兜底值也要让开语义色——它是唯一不经过派生函数的那个色相', () => {
    // 派生出的每个色相都被 conversation-avatar.test.tsx 钉住让开了语义色，但 CSS 里声明的那个兜底
    // 值走的是另一条路：它不经过 speakerColorHue，所以那条守卫对它完全失明。实测漂过——兜底写着
    // 145，离 `--green`（143°）只有 2°，正落在派生函数存在要避开的那片弧里。于是「派生色相不冒充
    // 状态」这条性质对每个真实身份都成立，唯独对读者最可能当作代表色的那一个不成立。
    //
    // 判据用模块自己导出的谓词，而不是在这里手抄一份保留色表：手抄就是把同一份数据放到第三个地方，
    // 而两个该联动的常量分居两文件必然漂移——这条断言存在的全部理由就是上一次的漂移。
    const avatarCss = new Map(styleFiles().map((file) => [file.name, file.text])).get('conversation-avatar.css')
    expect(avatarCss, 'conversation-avatar.css 不在 @import 列表里了').toBeDefined()
    const declared = /--speaker-hue:\s*([0-9.]+)\s*;/.exec(avatarCss!)
    expect(declared, '--speaker-hue 的兜底声明不见了——组件注入的自定义属性必须有声明的默认值').not.toBeNull()
    const hue = Number(declared![1])
    expect(clearsSemanticHues(hue), `兜底色相 ${hue}° 落在语义色的禁区里`).toBe(true)
  })

  it('全表拼起来仍是可扫描的一张表，契约测试因此不会扫到空内容', () => {
    const styles = allStyles()
    expect(styles.length).toBeGreaterThan(100_000)
    // 抽查几个分属不同文件的表面，证明拼接确实覆盖了全部而不是只读到第一个文件。
    expect(styles).toContain('--fs-body')          // tokens
    expect(styles).toContain('.status__dot')       // chrome
    expect(styles).toContain('.workspace-topic-item')  // dock
    expect(styles).toContain('.pane-body__region')     // workbench
    expect(styles).toContain('.activity-ruler')        // activity
  })
})
