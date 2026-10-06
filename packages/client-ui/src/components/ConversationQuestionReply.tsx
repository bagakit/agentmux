import type { AgentSessionHistoryQuestionAnswer } from '@agentmux/core'
import { memo, type ComponentProps } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { AgentMarkdown } from './AgentMarkdown.js'

type Props = Omit<ComponentProps<typeof AgentMarkdown>, 'content'> & {
  answers: readonly AgentSessionHistoryQuestionAnswer[]
  originalText?: string
}

/** Provider-projected reading only; the original message still owns Copy and identity. */
export const ConversationQuestionReply = memo(function ConversationQuestionReply({ answers, originalText, ...reading }: Props) {
  return <div className="log-turn__question-reply" data-recorded-question-reply>
    {answers.map((answer, index) => <div key={JSON.stringify([answer.questionId, index])} data-question-id={answer.questionId}>
      <div className="log-turn__text"><AgentMarkdown {...reading} content={answer.answer} /></div>
      {answer.prompt ? <details className="log-turn__reply-detail">
        <summary><SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />关联问题</summary>
        <p>{answer.prompt}</p>
      </details> : null}
    </div>)}
    {originalText !== undefined ? <details className="log-turn__reply-detail" data-question-reply-original>
      <summary><SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />原始记录</summary>
      <pre>{originalText}</pre>
    </details> : null}
  </div>
})
