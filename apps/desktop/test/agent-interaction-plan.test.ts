import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { AgentMuxPermissionOption } from '@agentmux/core'
import {
  isAffirmative,
  permissionPlan,
  questionPlan
} from '../src/renderer/src/lib/agent-interaction-plan.js'

// 「点这个控件，Agent 收到什么」——分两层守，因为这两层的失效方式不一样。
//
// 取值层（permissionPlan / questionPlan）是纯函数，可以直接调，所以「Allow once 答的是 selected 还是
// cancelled」在这里是可断言的。接线层（AgentInteractionCard 的 JSX）渲不出 handler：本仓 desktop 测试栈
// 是 renderToStaticMarkup，且这个组件带 useState 故也不能当纯函数直接调——于是它只能靠语法守。
//
// 这个分法有实测来历：重构前把 scoped 那两个 allow 的 onClick 整体换成 `{ outcome: 'cancelled' }`，
// 27 条测试全绿、tsc 也 exit 0——用户点「允许」，Agent 收到取消，界面上毫无差别。
//
// 两层的变异必须各红各自那一条：改坏映射只该红取值层，改坏转发只该红接线层。

const CARD = '../src/renderer/src/components/AgentInteractionCard.tsx'
const cardSource = readFileSync(new URL(CARD, import.meta.url), 'utf8')

describe('permission verdict projection', () => {
  // 手写的输入。期望值也全部手写，绝不从 plan 自己的输出里取——否则配错对的映射会跟着变异一起漂，
  // 断言恒真。
  const options: AgentMuxPermissionOption[] = [
    { id: 'allow-once', label: 'Allow once', kind: 'allow-once', tier: 'safe' },
    { id: 'allow-always', label: "Allow & don't ask again", kind: 'allow-always', tier: 'caution' },
    { id: 'deny', label: 'Deny', kind: 'reject-once', tier: 'safe' },
    { id: 'deny-always', label: 'Never allow', kind: 'reject-always', tier: 'safe' }
  ]

  it('answers each option with its own id, and never with a cancel', () => {
    const plan = permissionPlan({ id: 'permission-1', options })

    // 逐条对着手写字面量比：谁配了谁。共用一个 optionId（比如全答第一个）在这里必红。
    expect(plan.allows.map(({ option, response }) => [option.id, response])).toEqual([
      [
        'allow-once',
        {
          kind: 'permission',
          requestId: 'permission-1',
          decision: { outcome: 'selected', optionId: 'allow-once' }
        }
      ],
      [
        'allow-always',
        {
          kind: 'permission',
          requestId: 'permission-1',
          decision: { outcome: 'selected', optionId: 'allow-always' }
        }
      ]
    ])
    expect(plan.rejects.map(({ option, response }) => [option.id, response])).toEqual([
      [
        'deny',
        {
          kind: 'permission',
          requestId: 'permission-1',
          decision: { outcome: 'selected', optionId: 'deny' }
        }
      ],
      [
        'deny-always',
        {
          kind: 'permission',
          requestId: 'permission-1',
          decision: { outcome: 'selected', optionId: 'deny-always' }
        }
      ]
    ])

    // #411 那次事故的形状本身：任何一个「判决」控件都不许答成撤销。上面逐条比已经覆盖，这里再单独
    // 钉一次是因为它是这张卡最贵的一条不变量——判决与撤销混淆，用户看不出，Agent 也不会抱怨。
    for (const { option, response } of [...plan.allows, ...plan.rejects]) {
      expect(response.kind).toBe('permission')
      expect(response.kind === 'permission' ? response.decision.outcome : null).toBe('selected')
      expect(option).toBeTruthy()
    }

    // 撤销是另一件事，且只有它答 cancelled。
    expect(plan.dismiss).toEqual({
      kind: 'permission',
      requestId: 'permission-1',
      decision: { outcome: 'cancelled' }
    })
  })

  it('keeps every option reachable: allows and rejects partition the declared list', () => {
    const plan = permissionPlan({ id: 'permission-1', options })
    // 漏掉一个选项就是少一个按钮——用户看不见的那条路，Agent 却在等它。顺序也守：这两列都按声明顺序，
    // 因为 CLI 自己的提示列就是那个顺序，重排会让肌肉记忆点错。
    expect([...plan.allows, ...plan.rejects].map(({ option }) => option.id)).toEqual([
      'allow-once',
      'allow-always',
      'deny',
      'deny-always'
    ])
  })

  it('keeps choices in the order Core declared them even when a reject comes first', () => {
    // 这条必须用「否决在前」的输入：上面那份 fixture 恰好是 allow 在前，于是把紧凑行拼成
    // 「先肯定后否决」也照样绿——我自己第一版就是那么写的，这里是它的检测器。按钮顺序是 Core 的话事。
    const plan = permissionPlan({
      id: 'permission-1',
      options: [options[2]!, options[0]!, options[1]!]
    })
    expect(plan.choices.map(({ option }) => option.id)).toEqual([
      'deny',
      'allow-once',
      'allow-always'
    ])
    // 分类仍然分得对——顺序不重排，不等于类别也跟着乱。
    expect(plan.allows.map(({ option }) => option.id)).toEqual(['allow-once', 'allow-always'])
    expect(plan.rejects.map(({ option }) => option.id)).toEqual(['deny'])
  })

  it('classifies all four Core option kinds, so a new kind cannot default into allow', () => {
    // 穷举 Core 那个 union 的四个成员。这条既守极性，也守「加了第五种 kind 时这里会红」——
    // 因为漏判的后果是把一个否决当成放行。
    expect(isAffirmative({ id: 'a', label: 'a', kind: 'allow-once' })).toBe(true)
    expect(isAffirmative({ id: 'b', label: 'b', kind: 'allow-always' })).toBe(true)
    expect(isAffirmative({ id: 'c', label: 'c', kind: 'reject-once' })).toBe(false)
    expect(isAffirmative({ id: 'd', label: 'd', kind: 'reject-always' })).toBe(false)
  })

  it('promotes the affirmatives into the scoped column only when there are two of them', () => {
    // 分档判据与「答的是什么」同住一处，否则一个说这是 allow、另一个答的是 reject，两边各自绿。
    expect(permissionPlan({ id: 'p', options }).scoped).toBe(true)
    expect(
      permissionPlan({
        id: 'p',
        options: [options[0]!, options[2]!]
      }).scoped
    ).toBe(false)
    // 一个都没有也不该升列（Core 理论上可以只给否决）。
    expect(permissionPlan({ id: 'p', options: [options[2]!] }).scoped).toBe(false)
  })
})

describe('question verdict projection', () => {
  const request = {
    id: 'question-1',
    questions: [
      {
        id: 'scope',
        title: 'Scope',
        prompt: 'Which tests?',
        options: [
          { id: 'focused', label: 'Focused', description: 'Affected tests only' },
          { id: 'full', label: 'Full suite' }
        ]
      }
    ]
  }

  it('answers each choice with its own optionId under the asked questionId', () => {
    const plan = questionPlan(request)
    expect(plan.choices.map(({ option, response }) => [option.id, response])).toEqual([
      [
        'focused',
        {
          kind: 'question',
          requestId: 'question-1',
          outcome: 'answered',
          answers: [{ questionId: 'scope', optionId: 'focused' }]
        }
      ],
      [
        'full',
        {
          kind: 'question',
          requestId: 'question-1',
          outcome: 'answered',
          answers: [{ questionId: 'scope', optionId: 'full' }]
        }
      ]
    ])
    // 答复必须落在被问的那一问上。questionId 手抄成别的（或落回 request.id）时这里红。
    expect(plan.question.id).toBe('scope')
    expect(plan.dismiss).toEqual({
      kind: 'question',
      requestId: 'question-1',
      outcome: 'cancelled'
    })
  })
})

// ——— 接线层 ———
//
// 取值层全对，组件仍然可以把 allow 那个按钮接到 dismiss 上。那次变异只改一个标识符，所以
// 「组件里不许出现响应字面量」这种守卫对它完全是瞎的——判据必须是「这个按钮转发的是哪一个标识符」。
//
// 用 TS 自己的 parser：对每个 onClick，取它交给 respond() 的实参，再往上走一层看它在不在某个
// 「按选项 map」的回调里（形参解构出 response 的那种）。在里面就必须转发 response，不在就必须是
// dismiss。改动其中任何一个的接法都红。
type Forward = { argument: string; inChoiceMap: boolean }

function respondForwards(source: string): Forward[] {
  const file = ts.createSourceFile('card.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Forward[] = []

  // 这个回调是不是「按选项 map」出来的？判据是它的第一个形参解构出了 response——也就是取值层给的
  // 那条记录。用作用域关系判，不数出现次数。
  const bindsResponse = (node: ts.Node): boolean => {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false
    const [parameter] = node.parameters
    if (!parameter || !ts.isObjectBindingPattern(parameter.name)) return false
    return parameter.name.elements.some((element) => element.name.getText() === 'response')
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText() === 'onClick' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      // respond(X) 的 X。取的是调用实参而不是整段文本，这样 `void respond(x)` 的包法变了也照旧判得出。
      const calls: ts.CallExpression[] = []
      const collect = (inner: ts.Node): void => {
        if (ts.isCallExpression(inner) && inner.expression.getText() === 'respond') calls.push(inner)
        ts.forEachChild(inner, collect)
      }
      collect(node.initializer.expression)
      expect(calls).toHaveLength(1)
      const [call] = calls
      expect(call!.arguments).toHaveLength(1)

      let inChoiceMap = false
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (bindsResponse(parent)) {
          inChoiceMap = true
          break
        }
      }
      found.push({ argument: call!.arguments[0]!.getText(), inChoiceMap })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return found
}

describe('AgentInteractionCard forwards the projection instead of deciding', () => {
  it('gives every per-choice button its own response, and only dismiss the dismissal', () => {
    const forwards = respondForwards(cardSource)

    // 自检：提取器真的看见了控件。改名或换写法让它一个都找不到时这里红，而不是静默全绿。
    // 五个：scoped 那列 allow、紧凑动作行、提问的选项列，加两处 Cancel。
    expect(forwards).toHaveLength(5)
    expect(forwards.filter((forward) => forward.inChoiceMap)).toHaveLength(3)

    for (const { argument, inChoiceMap } of forwards) {
      // 按选项渲染出来的按钮，必须发它自己那一条——不是 dismiss，也不是别的记录的。
      // 这正是 #411 在重构后的等价变异（把 allow 接到 dismiss 上），它只换一个标识符。
      expect(argument).toBe(inChoiceMap ? 'response' : 'dismiss')
    }
  })

  it('constructs no response of its own, so the verdict has exactly one author', () => {
    const file = ts.createSourceFile('card.tsx', cardSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    // 响应形状独有的键。组件里一旦出现，就说明判决又有了第二处作者——取值层守住的那些不变量
    // 对那一处一概无效。
    const responseKeys = ['decision', 'outcome', 'answers', 'requestId']
    const authored: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        const key = node.name.getText().replace(/^['"]|['"]$/gu, '')
        if (responseKeys.includes(key)) authored.push(key)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
    expect(authored).toEqual([])

    // 取值必须真的走那两个纯函数——否则上面「不许自己构造」可以靠把判决藏进别的模块来满足。
    expect(cardSource).toContain('permissionPlan(request)')
    expect(cardSource).toContain('questionPlan(request)')
  })
})
