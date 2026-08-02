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
 * 只做取值，不做样式：分档（scoped 与否）、图标、主次都留在组件里。这里唯一表达的判断是
 * 「哪些选项是肯定答复」——因为它决定了布局分档，而它必须与「答复本身」同一处算，否则一个说
 * 这是 allow、另一个答的是 reject，两边各自绿。
 */

/** 肯定答复：用户放行这次工具调用。其余（reject-*）是对工具的否决。 */
export function isAffirmative(option: AgentMuxPermissionOption): boolean {
  return option.kind.startsWith('allow-')
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
