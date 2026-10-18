import type { QuestionPublicationPayload } from '../../publication-store.js'

/** Native form field names and callback layout belong only to this channel. */
export function feishuQuestionCard(payload: QuestionPublicationPayload, agentSessionId: string): Record<string, unknown> {
  const text = (content: string) => ({ tag: 'plain_text', content })
  const status = { pending: 'Choose one option or write an answer. Written text is used when provided.',
    'response-sent': 'Answer submitted to the original Agent. Native completion remains separate.',
    unconfirmed: 'Answer delivery is unconfirmed. It will not be sent again.',
    unavailable: 'Answer here is unavailable. Open the original conversation to continue.' }[payload.status]
  const elements: Record<string, unknown>[] = payload.status === 'pending' ? [] : [{ tag: 'div', text: text(payload.text) }]
  // Layout deduplication only: the typed original questions remain readable in every status.
  if (payload.status !== 'pending') for (const question of payload.questions) {
    if (!payload.text.includes(question.prompt) || question.options.some(option => !payload.text.includes(option.label)))
      elements.push({ tag: 'div', text: text([question.prompt, ...question.options.map(option => `- ${option.label}`)].join('\n')) })
  }
  elements.push({ tag: 'div', text: text(payload.status === 'unavailable' ? payload.unavailableReason ?? status : status) })
  if (payload.status !== 'pending') for (const answer of payload.answers ?? []) {
    const index = payload.questions.findIndex(question => question.id === answer.questionId)
    if (index !== -1) elements.push({ tag: 'div', text: text(`Answer ${index + 1}: ${answer.answer}`) })
  }
  if (payload.status === 'pending' && payload.actionRef) {
    const fields = payload.questions.map((question, index) => ({ questionId: question.id,
      ...(question.options.length ? { optionField: `question_${index}_option`, optionIds: question.options.map(option => option.id) } : {}),
      ...(question.acceptsText ? { textField: `question_${index}_text` } : {}) }))
    const controls = payload.questions.flatMap((question, index) => [
      { tag: 'div', text: text(question.prompt) },
      ...(question.options.length ? [{ tag: 'select_static', name: fields[index]!.optionField, behaviors: [], placeholder: text('Choose an option'),
        options: question.options.map((option, optionIndex) => ({ text: text(option.label), value: String(optionIndex) })) }] : []),
      ...(question.acceptsText ? [{ tag: 'input', name: fields[index]!.textField, input_type: 'multiline_text', placeholder: text('Your answer') }] : [])
    ])
    elements.push({ tag: 'form', name: 'original_question', elements: [...controls,
      { tag: 'button', name: 'submit_original_answer', text: text('Submit answers'), type: 'primary', action_type: 'form_submit',
        form_name: 'original_question', form_action_type: 'submit', value: { actionRef: payload.actionRef, questionFields: fields } }] })
  }
  elements.push({ tag: 'button', text: text('Open original conversation'), type: 'default',
    behaviors: [{ type: 'open_url', default_url: `amux://agent/${encodeURIComponent(agentSessionId)}` }] })
  const heading = { pending: 'Question from the Agent', 'response-sent': 'Answer submitted', unconfirmed: 'Answer delivery unconfirmed', unavailable: 'Question · answer unavailable' }[payload.status]
  return { schema: '2.0', config: { update_multi: true }, header: { title: text(heading), template: payload.status === 'pending' ? 'blue' : payload.status === 'response-sent' ? 'green' : payload.status === 'unconfirmed' ? 'orange' : 'grey' }, body: { elements } }
}
