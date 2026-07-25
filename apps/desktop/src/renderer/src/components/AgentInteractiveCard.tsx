import { useState, type ReactNode } from 'react'
import { Check, HelpCircle, ShieldAlert, X } from 'lucide-react'

export type AskOption = {
  label: string
  description?: string | undefined
}

export type AskQuestion = {
  question: string
  header?: string | undefined
  multiSelect?: boolean | undefined
  options: AskOption[]
}

export type AskPrompt = {
  questions: AskQuestion[]
}

export type ChatApproval = {
  title: string
  detail?: string | undefined
  options: { label: string; send: string }[]
}

export type InteractivePromptCard =
  | { kind: 'question'; prompt: AskPrompt }
  | { kind: 'approval'; approval: ChatApproval }
  | null

const ESCAPE = '\u001b'

export function parseApprovalFromStatus(
  interactivePrompt: string | undefined | null
): ChatApproval | null {
  if (!interactivePrompt) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    if (/permission|approval|allow/i.test(interactivePrompt)) {
      return {
        title: 'Allow Action?',
        detail: interactivePrompt,
        options: [
          { label: 'Allow', send: '1' },
          { label: 'Deny', send: ESCAPE }
        ]
      }
    }
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const approval = (parsed as { approval?: unknown }).approval
  if (!approval || typeof approval !== 'object') return null
  const tool = (approval as { tool?: unknown }).tool
  if (typeof tool !== 'string' || tool.length === 0) return null
  const summary = (approval as { summary?: unknown }).summary
  return {
    title: `Allow ${tool}?`,
    detail: typeof summary === 'string' && summary.length > 0 ? summary : undefined,
    options: [
      { label: 'Allow', send: '1' },
      { label: 'Deny', send: ESCAPE }
    ]
  }
}

export function parseAskFromStatus(
  interactivePrompt: string | undefined | null,
  _toolName?: string
): AskPrompt | null {
  if (!interactivePrompt) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const rawQuestions = (parsed as { questions?: unknown }).questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null

  const questions: AskQuestion[] = []
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') continue
    const q = raw as Record<string, unknown>
    const text = typeof q.question === 'string' ? q.question : ''
    const rawOptions = Array.isArray(q.options) ? q.options : []
    const options: AskOption[] = rawOptions.map((opt) => {
      if (typeof opt === 'string') return { label: opt, description: undefined }
      if (opt && typeof opt === 'object' && typeof (opt as { label?: unknown }).label === 'string') {
        const desc = typeof (opt as { description?: unknown }).description === 'string'
          ? (opt as { description: string }).description
          : undefined
        return {
          label: (opt as { label: string }).label,
          description: desc
        }
      }
      return { label: String(opt), description: undefined }
    })
    if (text || options.length > 0) {
      questions.push({
        question: text,
        header: typeof q.header === 'string' ? q.header : undefined,
        multiSelect: q.multiSelect === true,
        options
      })
    }
  }
  return questions.length > 0 ? { questions } : null
}

export function parseInteractivePrompt(
  interactivePrompt: string | undefined | null,
  toolName?: string
): InteractivePromptCard {
  const prompt = parseAskFromStatus(interactivePrompt, toolName)
  if (prompt) return { kind: 'question', prompt }
  const approval = parseApprovalFromStatus(interactivePrompt)
  if (approval) return { kind: 'approval', approval }
  return null
}

export function AgentApprovalCard({
  approval,
  onChoose
}: {
  approval: ChatApproval
  onChoose: (send: string) => void
}) {
  return (
    <div className="agent-interactive-card" data-agent-interactive-card="approval">
      <div className="agent-interactive-card__header">
        <ShieldAlert size={16} className="agent-interactive-card__icon text-amber" />
        <div>
          <div className="agent-interactive-card__title">{approval.title}</div>
          {approval.detail ? (
            <div className="agent-interactive-card__detail">{approval.detail}</div>
          ) : null}
        </div>
      </div>
      <div className="agent-interactive-card__actions">
        {approval.options.map((opt, i) => (
          <button
            key={`${opt.label}-${i}`}
            type="button"
            className={i === 0 ? 'small-button small-button--primary' : 'small-button'}
            onClick={() => onChoose(opt.send)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function AgentQuestionCard({
  prompt,
  onAnswer,
  onCancel
}: {
  prompt: AskPrompt
  onAnswer: (answer: string) => void
  onCancel: () => void
}) {
  const [questionIndex, setQuestionIndex] = useState(0)
  const [selectedIndices, setSelectedIndices] = useState<number[]>([])
  const [customText, setCustomText] = useState('')

  const question = prompt.questions[questionIndex]
  if (!question) return null

  function toggleOption(i: number) {
    if (!question) return
    if (question.multiSelect) {
      setSelectedIndices((prev) =>
        prev.includes(i) ? prev.filter((idx) => idx !== i) : [...prev, i]
      )
    } else {
      setSelectedIndices([i])
    }
  }

  function submit() {
    if (!question) return
    const picked = selectedIndices.map((i) => question.options[i]?.label).filter(Boolean)
    const custom = customText.trim()
    const answer = [...picked, ...(custom ? [custom] : [])].join(', ')
    if (answer) {
      onAnswer(answer)
    }
  }

  return (
    <div className="agent-interactive-card" data-agent-interactive-card="question">
      <div className="agent-interactive-card__header">
        <HelpCircle size={16} className="agent-interactive-card__icon" />
        <div className="agent-interactive-card__title-row">
          <div className="agent-interactive-card__title">
            {question.header ?? 'Question'}
          </div>
          <button
            type="button"
            className="composer-tool"
            onClick={onCancel}
            title="Cancel"
            aria-label="Cancel question"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      {question.question ? (
        <div className="agent-interactive-card__question-text">{question.question}</div>
      ) : null}
      <div className="agent-interactive-card__options">
        {question.options.map((opt, i) => {
          const isSelected = selectedIndices.includes(i)
          return (
            <button
              key={`${opt.label}-${i}`}
              type="button"
              className={`agent-interactive-card__option ${isSelected ? 'agent-interactive-card__option--selected' : ''}`}
              onClick={() => toggleOption(i)}
            >
              <span className="agent-interactive-card__option-bullet">
                {isSelected ? <Check size={12} /> : `${i + 1}`}
              </span>
              <span className="agent-interactive-card__option-label">{opt.label}</span>
              {opt.description ? (
                <span className="agent-interactive-card__option-desc">{opt.description}</span>
              ) : null}
            </button>
          )
        })}
      </div>
      <div className="agent-interactive-card__custom-input">
        <input
          type="text"
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Or type custom answer…"
        />
        <button
          type="button"
          className="small-button small-button--primary"
          onClick={submit}
        >
          Submit
        </button>
      </div>
    </div>
  )
}

export function AgentInteractiveCard({
  interactivePrompt,
  toolName,
  onSend,
  onInterrupt
}: {
  interactivePrompt?: string | null
  toolName?: string
  onSend: (text: string) => void
  onInterrupt: () => void
}) {
  const card = parseInteractivePrompt(interactivePrompt, toolName)
  if (!card) return null

  if (card.kind === 'approval') {
    return <AgentApprovalCard approval={card.approval} onChoose={onSend} />
  }

  return (
    <AgentQuestionCard
      prompt={card.prompt}
      onAnswer={onSend}
      onCancel={onInterrupt}
    />
  )
}
