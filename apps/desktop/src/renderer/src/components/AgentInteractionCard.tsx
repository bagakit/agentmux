import { Ban, Check, HelpCircle, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import type {
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse
} from '@agentmux/core'
import { isAffirmative, permissionPlan, permissionTierClassName, questionPlan } from '../lib/agent-interaction-plan'

/**
 * Agent 卡点的渲染层——只画，不判。
 *
 * 「点了发生什么」全部来自 agent-interaction-plan：每个可点的东西自带一条 `response`，这里原样
 * 交给 onRespond，不在 JSX 里第二次构造响应。这么切是因为本仓测试栈渲不出 handler，而这个组件带
 * useState 故也不能当纯函数直接调——判决留在闭包里就等于没人守。实测过：把 scoped 那两个 allow
 * 的 onClick 换成 cancelled，27 条测试与 tsc 全都沉默，用户点「允许」而 Agent 收到取消。
 */
export function AgentInteractionCard({
  request,
  disabled = false,
  onRespond
}: {
  request: AgentMuxInteractionRequest
  disabled?: boolean
  onRespond(response: AgentMuxInteractionResponse): Promise<void>
}) {
  const [submitting, setSubmitting] = useState(false)
  const unavailable = disabled || submitting
  async function respond(response: AgentMuxInteractionResponse): Promise<void> {
    if (unavailable) return
    setSubmitting(true)
    try {
      await onRespond(response)
    } finally {
      setSubmitting(false)
    }
  }

  // 按 request 自己的 kind 分派，让 TS 收窄出这一支独有的展示字段（title/toolName/toolInput）；
  // 取值仍然只有一处，就是下面这个 plan。
  if (request.kind === 'permission') {
    // 分档由取值层算：两个以上肯定答复时它们升进竖排编号列，与 CLI 自己的提示列同形；
    // 否则塌回紧凑动作行。判据与「答的是什么」同住一处，不在这里重算。
    const { choices, allows, rejects, scoped, dismiss } = permissionPlan(request)
    return (
      <section className="agent-interaction" aria-label="Agent permission request">
        <div className="agent-interaction__heading">
          <ShieldAlert size={15} />
          <div>
            <strong>{request.title}</strong>
            {request.toolName ? <span>{request.toolName}</span> : null}
          </div>
        </div>
        {request.toolInput ? <pre>{request.toolInput}</pre> : null}
        {scoped ? (
          <div className="agent-interaction__grants">
            {allows.map(({ option, response }) => (
              <button
                key={option.id}
                type="button"
                disabled={unavailable}
                className={option.kind === 'allow-once' ? 'is-primary' : undefined}
                onClick={() => void respond(response)}
              >
                <span
                  className={permissionTierClassName(option)}
                  aria-hidden="true"
                />
                <span className="agent-interaction__grant-text">
                  <span>{option.label}</span>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="agent-interaction__actions">
          {/* Dismissing the request is not a decision about the tool, so it sits apart from the
              allow/deny pair rather than reading as a third verdict. */}
          <button
            type="button"
            className="agent-interaction__dismiss"
            disabled={unavailable}
            onClick={() => void respond(dismiss)}
          >
            Cancel
          </button>
          {/* 升列时紧凑行只剩否决；没升列时按 Core 的声明顺序画全部——顺序由取值层给，不在这里拼。 */}
          {(scoped ? rejects : choices).map(({ option, response }) => (
            <button
              key={option.id}
              type="button"
              disabled={unavailable}
              className={option.kind === 'allow-once' ? 'is-primary' : undefined}
              onClick={() => void respond(response)}
            >
              {isAffirmative(option) ? <Check size={12} /> : <Ban size={12} />}
              {option.label}
            </button>
          ))}
        </div>
      </section>
    )
  }

  const { question, choices, dismiss } = questionPlan(request)
  return (
    <section className="agent-interaction" aria-label="Agent question">
      <div className="agent-interaction__heading">
        <HelpCircle size={15} />
        <div>
          {question.title ? <strong>{question.title}</strong> : null}
          <span>{question.prompt}</span>
        </div>
      </div>
      <div className="agent-interaction__options">
        {choices.map(({ option, response }) => (
          <button
            key={option.id}
            type="button"
            disabled={unavailable}
            onClick={() => void respond(response)}
          >
            <span>{option.label}</span>
            {option.description ? <small>{option.description}</small> : null}
          </button>
        ))}
      </div>
      <div className="agent-interaction__actions">
        <button
          type="button"
          className="agent-interaction__dismiss"
          disabled={unavailable}
          onClick={() => void respond(dismiss)}
        >
          Cancel
        </button>
      </div>
    </section>
  )
}
