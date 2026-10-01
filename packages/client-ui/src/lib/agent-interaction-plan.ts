import type {
  AgentMuxInteractionResponse,
  AgentMuxPermissionOption,
  AgentMuxQuestion
} from '@agentmux/core'

/**
 * 「点这个控件，Agent 收到什么」——作为数据，而不是埋在 JSX 里的闭包。
 *
 * 这里是权限卡点与提问卡点的取值层：每一个可点的东西都摊成一条带 `response` 的记录，组件只负责
 * 把 `response` 原样交给 onRespond。这么切的理由是可断言性：本仓 desktop 测试栈是
 * renderToStaticMarkup，渲不出 handler，而这个组件带 useState 故也不能当纯函数直接调——于是
 * 「Allow once 到底答的是 selected 还是 cancelled」在原来的写法里根本没有任何测试能看见。实测过：
 * 把 scoped 那两个 allow 的 onClick 整体换成 `{ outcome: 'cancelled' }`，27 条测试全绿、tsc 也
 * exit 0——用户点「允许」，Agent 收到的是取消，界面上毫无差别。同一条思路已经在
 * agent-roster-menu.ts 用过，那里的注释也写明了同一个原因。
 *
 * 布局分档（scoped 与否）、图标、主次仍留在组件里。这里表达两条判断，都是因为「说错了会骗人」而必须
 * 与取值同住：一是「哪些选项是肯定答复」——它决定布局分档，若与「答复本身」分开算，就会一个说这是
 * allow、另一个答的是 reject，两边各自绿；二是「这个选项声称的风险档」——见
 * `permissionTierClassName`，缺席必须能被表达成「不知道」，而那件事一旦交给 JSX 拼字符串，就有机会
 * 被一个 `??` 变成乐观的谎。除此之外的样式仍不在这里。
 */

/** 肯定答复：用户放行这次工具调用。其余（reject-*）是对工具的否决。 */
export function isAffirmative(option: AgentMuxPermissionOption): boolean {
  return option.kind.startsWith('allow-')
}

/**
 * 风险点的 class 列表——**未声明 tier 时不给档位修饰类**，只留基类。
 *
 * `tier` 在 `AgentMuxPermissionOption` 上是可选的，而缺席是真可达的：`acp-adapter.ts` 里
 * `options: event.options.map((option) => ({ ...option }))` 把外部 ACP 客户端声明的选项整份摊平带过来，
 * 那些选项完全可以不带 tier。此前组件里写的是 `option.tier ?? 'safe'`，于是**没被分类的选项被画成绿色
 * 「safe」**——把「我不知道这有多危险」说成「这是安全的」，正好在权限卡点这个最不该乐观的地方。
 *
 * 判据落在这里而不是 JSX 里：基类 `.agent-interaction__tier` 自带中性 `var(--text-3)`，所以省掉修饰类
 * 就是「点还在、槽位还在、但不声称任何档位」。返回 string 而不是 `RiskTier | undefined`，是为了让
 * 「拼 class」这件事只发生一处——组件那侧曾经就是因为要自己拼，才有机会插进一个 `??`。
 */
export function permissionTierClassName(option: AgentMuxPermissionOption): string {
  const base = 'agent-interaction__tier'
  return option.tier === undefined ? base : `${base} ${base}--${option.tier}`
}

export type PermissionChoice = {
  option: AgentMuxPermissionOption
  /** 点它就发这条——组件不得再构造第二个响应。 */
  response: AgentMuxInteractionResponse
}

export type PermissionPlan = {
  /**
   * 全部选项，严格按 Core 的声明顺序——紧凑行照这个顺序画。
   *
   * 单独有这一条而不是让紧凑行拼 `[...allows, ...rejects]`：那样拼出来的是「先肯定后否决」，
   * Core 若把 deny 声明在前，按钮顺序就跟着变了，而只要 fixture 恰好是 allow 在前就永远测不出来。
   * 顺序是 Core 的话事，这里不重排。
   */
  choices: PermissionChoice[]
  /** 肯定答复，按声明顺序。 */
  allows: PermissionChoice[]
  /** 否决，按声明顺序。 */
  rejects: PermissionChoice[]
  /**
   * 两个以上肯定答复时（Claude 的 allow-once + allow-always），肯定答复升进竖排编号列，
   * 与 CLI 自己的提示列同形；否则塌回紧凑动作行。
   */
  scoped: boolean
  /** 撤掉这次请求——不是对工具的判决，故与 allow/deny 分开摆。 */
  dismiss: AgentMuxInteractionResponse
}

export function permissionPlan(request: {
  id: string
  options: readonly AgentMuxPermissionOption[]
}): PermissionPlan {
  const select = (option: AgentMuxPermissionOption): PermissionChoice => ({
    option,
    response: {
      kind: 'permission',
      requestId: request.id,
      decision: { outcome: 'selected', optionId: option.id }
    }
  })
  const choices = request.options.map(select)
  const allows = choices.filter(({ option }) => isAffirmative(option))
  return {
    choices,
    allows,
    rejects: choices.filter(({ option }) => !isAffirmative(option)),
    scoped: allows.length >= 2,
    dismiss: {
      kind: 'permission',
      requestId: request.id,
      decision: { outcome: 'cancelled' }
    }
  }
}

export type QuestionChoice = {
  option: AgentMuxQuestion['options'][number]
  response: AgentMuxInteractionResponse
}

export type QuestionPlan = {
  question: AgentMuxQuestion
  choices: QuestionChoice[]
  dismiss: AgentMuxInteractionResponse
}

export function questionPlan(request: {
  id: string
  questions: readonly AgentMuxQuestion[]
}): QuestionPlan {
  // Core 保证至少一问：单选一问是这张卡承诺渲染的全部形状。
  const question = request.questions[0]!
  const answer = (optionId: string): AgentMuxInteractionResponse => ({
    kind: 'question',
    requestId: request.id,
    outcome: 'answered',
    answers: [{ questionId: question.id, optionId }]
  })
  return {
    question,
    choices: question.options.map((option) => ({
      option,
      response: answer(option.id)
    })),
    dismiss: {
      kind: 'question',
      requestId: request.id,
      outcome: 'cancelled'
    }
  }
}
