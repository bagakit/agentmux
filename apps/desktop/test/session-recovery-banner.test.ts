import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { AGENT_DISPLAY_STATES } from '../src/renderer/src/lib/attention-vocabulary'
import {
  sessionRecoveryClassName,
  sessionRecoveryState
} from '../src/renderer/src/lib/session-recovery-banner'
import { allStyleRules } from './helpers/styles.js'

/**
 * 终端/Agent 恢复横幅的状态与颜色。
 *
 * 为什么单独有这个文件：横幅那格图标此前把 `disconnected` 写死成 `var(--amber)`，而
 * chrome.css 的状态色表明确判它是 `--text-3`，且色表上方的注释写明「琥珀只表示等你」——所以那抹
 * 琥珀本身就是缺陷：一条掉线的链路被画成了「你是瓶颈」。它能活到今天的原因很直接：**这一格的颜色
 * （无论琥珀还是红）没有任何测试盯着**。所以这里的判据不是「横幅渲染出来了」，而是「这一格的颜色
 * 从哪来」。
 */

const COMPONENT = new URL('../src/renderer/src/components/SessionPane.tsx', import.meta.url)

describe('恢复横幅的状态只判一次', () => {
  it('三个可达取值各自对上，且优先级是 disconnected > exited > error', () => {
    expect(sessionRecoveryState({ disconnected: true, exited: false })).toBe('disconnected')
    expect(sessionRecoveryState({ disconnected: false, exited: true })).toBe('exited')
    expect(sessionRecoveryState({ disconnected: false, exited: false })).toBe('error')
    // 两个事实同时为真时（进程退了、同时这条链路也断了）先说掉线：链路一恢复，退出原因还能如实取到，
    // 反过来则会把「重连中」写成终局。这条断言就是那个优先级本身，不是复述上面三条。
    expect(sessionRecoveryState({ disconnected: true, exited: true })).toBe('disconnected')
  })

  it('版式类与颜色类同源：两个后缀恒等，且不带 .status 本体', () => {
    for (const state of AGENT_DISPLAY_STATES) {
      const className = sessionRecoveryClassName(state)
      expect(className).toContain(`terminal-recovery--${state}`)
      expect(className).toContain(`status--${state}`)
    }
    // 守的是恒等而不是几个例子：把其中一个后缀换成别的状态名，上面那条循环立刻红。
    // 而 `.status` 本体不许带——它是 `display:inline-flex` + `capitalize` 的行内小构件语汇，
    // 套到横幅上会掀翻 grid 版式并把正文措辞大写化。需要的只是 `--status-ink` 那次赋值。
    const classes = sessionRecoveryClassName('disconnected').split(/\s+/u)
    expect(classes).not.toContain('status')
  })
})

describe('横幅那格图标的颜色来自状态色表', () => {
  const styles = allStyleRules()

  it('图标规则读 --status-ink，且没有任何按状态自己挑色的兄弟规则', () => {
    // 这一条就是 F1 的判据。分两侧：
    //   正面——那格图标必须有一条读 `var(--status-ink)` 的规则；
    //   反面——任何以 `terminal-recovery--<state>` 为键的规则，规则体里都不许出现色相 token
    //         或颜色字面量。少了反面，加一条读 token 的规则之后，旁边照旧可以留一条写死琥珀的，
    //         而「有一条读了」的断言仍然绿——那正是 #420 的形状（角标背景换成 #ffb020，描边那条
    //         替它顶住，45 条全绿）。
    expect(styles).toMatch(/\.terminal-recovery__icon[^,{]*\{[^}]*var\(\s*--status-ink\s*\)/u)

    const HUES = ['--green', '--amber', '--red', '--blue', '--neutral-3', '--text-3']
    const offenders: string[] = []
    for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const selector = match[1]!.trim().replace(/\s+/gu, ' ')
      if (!/\.terminal-recovery--/u.test(selector)) continue
      const body = match[2]!
      const hits = [
        ...HUES.filter((hue) => new RegExp(`var\\(\\s*${hue}\\b`, 'u').test(body)),
        ...[...body.matchAll(/#[0-9a-f]{3,8}\b/giu)].map((hit) => hit[0]!),
        ...[...body.matchAll(/\b(?:rgba?|hsla?|color-mix)\s*\(/giu)].map((hit) => hit[0]!)
      ]
      if (hits.length > 0) offenders.push(`${selector} -> ${hits.join(', ')}`)
    }
    expect(offenders, '横幅按状态自己挑了颜色，状态色只能来自 --status-ink').toEqual([])
  })

  it('每个可达的横幅状态都有一条赋 --status-ink 的规则接得住', () => {
    // 光有 `var(--status-ink)` 不够：那是个继承来的自定义属性，没有任何 `.status--<state>` 规则
    // 落在这个元素上时它会退回 `.status` 的缺省——而横幅不带 `.status` 本体，于是整格变成
    // 「无颜色」而不是响亮报错。所以逐个状态问：色表里真有赋值给它的那条规则吗。
    //
    // 判据必须逐条拆开选择器列表，不能用 `\.status--error[^,{]*\{` 这类正则：色表里那条是
    // `.status--error, .status--exited { … }`，`[^,{]*` 不许跨逗号，于是只有列表**最后**那个
    // 状态能被认出来（实测：这条判据第一版就把 error 误报成缺席）。同一个盲点也会反向发作——
    // 谁被写在列表首位就永远过不了判据，而它明明有色。
    const assignsInk = (state: string): boolean => {
      for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        if (!/--status-ink\s*:/u.test(match[2]!)) continue
        const members = match[1]!.split(',').map((member) => member.trim())
        if (members.some((member) => new RegExp(`\\.status--${state}(?![\\w-])`, 'u').test(member))) {
          return true
        }
      }
      return false
    }
    for (const state of ['disconnected', 'exited', 'error'] as const) {
      expect(
        assignsInk(state),
        `.status--${state} 没有给 --status-ink 赋值，横幅这一格会变成无颜色`
      ).toBe(true)
    }
    // 自检：判据认得出缺席。一个不存在的状态名必须落空，否则上面那三条是恒真的。
    expect(assignsInk('nonexistent')).toBe(false)
  })
})

describe('横幅的 class 由那个纯函数产出', () => {
  it('组件里没有手抄的 terminal-recovery-- 拼接，class 就是那次调用的返回值', () => {
    const source = readFileSync(COMPONENT, 'utf8')
    const file = ts.createSourceFile(COMPONENT.pathname, source, ts.ScriptTarget.Latest, true)

    // 判「接线」而不是「字符串在场」：找到那个 className，要求它的值**就是** sessionRecoveryClassName
    // 的调用结果。此前这里是一个三元表达式内联拼 `terminal-recovery--${...}`，于是版式类与颜色类
    // 会各算一次——两处手抄一定漂移，而漂移的症状是版式说掉线、颜色说崩了。
    const wired: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText() === 'className') {
        const initializer = node.initializer
        if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
          const expression = initializer.expression
          if (
            ts.isCallExpression(expression) &&
            expression.expression.getText() === 'sessionRecoveryClassName'
          ) {
            wired.push(expression.getText())
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(wired).toHaveLength(1)
    // 实参也要对：调的是那个判定函数，而不是随便一个别处算好的状态。
    expect(wired[0]).toContain('sessionRecoveryState(')

    // 组件里不许再出现手抄的修饰类拼法。`terminal-recovery` 裸类名不在禁令内（横幅内部还有
    // `__icon` / `__actions` 这些子类），只禁 `terminal-recovery--`，那才是状态那一段。
    expect(source).not.toContain('terminal-recovery--')
  })
})
