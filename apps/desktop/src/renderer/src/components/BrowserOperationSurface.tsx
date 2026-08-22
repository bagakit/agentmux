import {
  CheckCircle2,
  CircleAlert,
  CircleDot,
  CircleX,
  Hand,
  History,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Square,
  UserRound
} from 'lucide-react'
import type { AgentProviderId } from '@agentmux/core'
import type {
  BrowserActivityState,
  BrowserOperation,
  BrowserOperationPhase,
  BrowserOperationStep,
  BrowserReplayPlan
} from '../../../shared/browser-operation'
import type { BrowserScriptRunReport } from '../../../shared/contracts'
import { AgentAvatar } from './AgentAvatar'
import { SemanticIcon } from './semantic-icons'

/**
 * The operator rail is deliberately a small, persistent surface. It answers three questions in one
 * line: who is driving, what phase they are in, and which semantic target is currently under review.
 * The browser page remains visible below it; this surface never intercepts page input.
 */
export function BrowserOperationRail({
  activity,
  onTakeControl,
  onReturnControl,
  onStop,
  onOpenTimeline
}: {
  activity: BrowserActivityState
  onTakeControl?: () => void
  onReturnControl?: () => void
  onStop?: () => void
  onOpenTimeline?: () => void
}) {
  const operation = activity.operation
  if (!operation) {
    const agentControl = activity.control === 'agent'
    // The Browser page is the primary surface.  A quiet human-owned tab has no operation fact to
    // explain, so rendering a "ready" card here would turn a control hint into the only visible page.
    // Keep the rail for an active handoff or a durable warning where it carries real information.
    if (!agentControl && !activity.warning && !onOpenTimeline) return null
    const quietHuman = !agentControl && !activity.warning
    return (
      <div className={`browser-rsi-rail browser-rsi-rail--idle${quietHuman ? ' browser-rsi-rail--quiet' : ''}`} role="status" aria-label="Browser activity">
        {!quietHuman ? <CircleDot size={13} aria-hidden="true" /> : null}
        {!quietHuman ? <span className="browser-rsi-rail__copy">
          <strong>{agentControl ? 'Agent control active' : 'Browser ready'}</strong>
          <small>{agentControl ? 'Activity details are loading…' : 'You have control'}</small>
        </span> : null}
        {activity.warning ? <span className="browser-rsi-rail__warning" role="status"><CircleAlert size={12} aria-hidden="true" />{activity.warning}</span> : null}
        {onOpenTimeline ? <span className="browser-rsi-rail__actions"><button type="button" className="browser-rsi-icon-button" aria-label="Open browser activity timeline" title="Open activity timeline" onClick={onOpenTimeline}><History size={13} aria-hidden="true" /></button></span> : null}
      </div>
    )
  }

  const canTakeControl = activity.control === 'agent' && operation.phase !== 'completed' && operation.phase !== 'failed' && operation.phase !== 'stopped'
  const canReturnControl = activity.control === 'human' && Boolean(onReturnControl)
  const target = currentTarget(operation)
  return (
    <section
      className={`browser-rsi-rail browser-rsi-rail--${operation.phase}`}
      data-control={activity.control}
      data-operation-id={operation.id}
      aria-label={`Browser operation by ${operation.operator.name}`}
    >
      <span className="browser-rsi-rail__identity" title={`${operation.operator.name} · ${operation.operator.id}`}>
        <AgentAvatar label={operation.operator.name} sessionId={operation.operator.id}
          {...(operation.operator.providerId ? { providerId: operation.operator.providerId as AgentProviderId } : {})}
          size={18}
        />
        <span><strong>{operation.operator.name}</strong><small>{phaseLabel(operation.phase)}</small></span>
      </span>
      <span className="browser-rsi-rail__target" title={target ?? operation.url}>
        <PhaseGlyph phase={operation.phase} />
        <span><strong>{target ?? operation.summary}</strong><small>{operation.url}</small></span>
      </span>
      {operation.warning || activity.warning ? <span className="browser-rsi-rail__warning" role="status"><CircleAlert size={12} aria-hidden="true" />{operation.warning ?? activity.warning}</span> : null}
      <span className="browser-rsi-rail__actions">
        {canTakeControl && onTakeControl ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={onTakeControl}><Hand size={13} aria-hidden="true" />Take control</button> : null}
        {canReturnControl && onReturnControl ? <button type="button" className="browser-rsi-button browser-rsi-button--primary" onClick={onReturnControl}><RotateCcw size={13} aria-hidden="true" />Return to Agent</button> : null}
        {onStop && operation.phase !== 'completed' && operation.phase !== 'failed' && operation.phase !== 'stopped' ? <button type="button" className="browser-rsi-icon-button" aria-label="Stop browser operation" title="Stop operation" onClick={onStop}><Square size={12} aria-hidden="true" /></button> : null}
        {onOpenTimeline ? <button type="button" className="browser-rsi-icon-button" aria-label="Open browser activity timeline" title="Open activity timeline" onClick={onOpenTimeline}><History size={13} aria-hidden="true" /></button> : null}
      </span>
    </section>
  )
}

/**
 * A timeline that carries operation facts, rather than a second stream of inferred Agent thinking.
 * A step may be selected for a target highlight or replay preview; both affordances are optional so
 * the read-only timeline stays a real read-only surface when the host has no handler yet.
 */
export function BrowserOperationTimeline({
  operation,
  warning,
  onSelectStep,
  onReplay
}: {
  operation: BrowserOperation | null
  warning?: string
  onSelectStep?: (step: BrowserOperationStep) => void
  onReplay?: (operation: BrowserOperation) => void
}) {
  if (!operation) {
    return <div className="browser-rsi-timeline browser-rsi-timeline--empty" role="status"><History size={14} aria-hidden="true" /><span>No browser activity yet</span></div>
  }
  return (
    <section className="browser-rsi-timeline" data-operation-id={operation.id} aria-label={`Browser activity timeline for ${operation.operator.name}`}>
      <header className="browser-rsi-timeline__header">
        <span><History size={14} aria-hidden="true" /><strong>Activity timeline</strong><small>{operation.steps.length} {operation.steps.length === 1 ? 'step' : 'steps'} · {phaseLabel(operation.phase)}</small></span>
        {onReplay ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={() => onReplay(operation)}><Play size={12} aria-hidden="true" />Replay</button> : null}
      </header>
      {operation.warning || warning ? <p className="browser-rsi-timeline__warning" role="status"><CircleAlert size={12} aria-hidden="true" />{operation.warning ?? warning}</p> : null}
      <ol className="browser-rsi-timeline__list">
        {operation.steps.length === 0 ? <li className="browser-rsi-timeline__empty">Waiting for the first observed action…</li> : operation.steps.map((step) => {
          const item = (
            <span className="browser-rsi-timeline__step-content">
              <span className="browser-rsi-timeline__step-head"><strong>{step.label}</strong><time dateTime={new Date(step.startedAt).toISOString()}>{formatClock(step.startedAt)}</time></span>
              <span className="browser-rsi-timeline__step-meta"><code>{step.method}</code>{targetLabel(step.target) ? <span>{targetLabel(step.target)}</span> : null}</span>
              {step.summary ? <small>{step.summary}</small> : null}
            </span>
          )
          return (
            <li key={`${step.sequence}-${step.startedAt}`} className={`browser-rsi-timeline__step browser-rsi-timeline__step--${step.status}`} data-sequence={step.sequence}>
              <span className="browser-rsi-timeline__marker" aria-hidden="true"><StepGlyph status={step.status} /></span>
              {onSelectStep ? <button type="button" className="browser-rsi-timeline__step-button" onClick={() => onSelectStep(step)} aria-label={`Inspect step ${step.sequence}: ${step.label}`}>{item}</button> : item}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/**
 * Durable Browser operations are selectable facts, not a second inferred activity stream. The list is
 * intentionally compact so opening history does not push the page out of view; the selected operation's
 * full timeline remains below it.
 */
export function BrowserOperationHistory({
  operations,
  selectedOperationId,
  loading = false,
  error,
  onSelect,
  onRetry,
  onClose
}: {
  operations: BrowserOperation[]
  selectedOperationId?: string | null
  loading?: boolean
  error?: string | null
  onSelect?: (operation: BrowserOperation) => void
  onRetry?: () => void
  onClose?: () => void
}) {
  return (
    <section className="browser-rsi-history" aria-label="Browser operation history">
      <header className="browser-rsi-history__header">
        <span><History size={13} aria-hidden="true" /><strong>Recent operations</strong><small>{loading ? 'Loading…' : `${operations.length} recorded`}</small></span>
        <span className="browser-rsi-history__actions">
          {error && onRetry ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={onRetry}>Retry</button> : null}
          {onClose ? <button type="button" className="browser-rsi-icon-button" aria-label="Close browser activity timeline" title="Close activity timeline" onClick={onClose}>×</button> : null}
        </span>
      </header>
      {error ? <p className="browser-rsi-history__error" role="status"><CircleAlert size={12} aria-hidden="true" />{error}</p> : null}
      {!loading && !error && operations.length === 0 ? <p className="browser-rsi-history__empty">No recorded Browser operations yet.</p> : null}
      {operations.length > 0 ? (
        <ol className="browser-rsi-history__list">
          {operations.map((operation) => (
            <li key={operation.id}>
              <button
                type="button"
                className={`browser-rsi-history__item${selectedOperationId === operation.id ? ' is-selected' : ''}`}
                aria-pressed={selectedOperationId === operation.id}
                onClick={() => onSelect?.(operation)}
              >
                <span className="browser-rsi-history__item-icon"><PhaseGlyph phase={operation.phase} /></span>
                <span className="browser-rsi-history__item-copy"><strong>{operation.operator.name}</strong><small>{operation.summary}</small></span>
                <time dateTime={new Date(operation.startedAt).toISOString()}>{formatClock(operation.startedAt)}</time>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}

/**
 * Replay is a review surface first. The plan intentionally exposes semantic targets and variable keys,
 * never raw input or opaque JavaScript/CDP arguments. A blocked step stays visible with its reason so a
 * human can decide how to complete it; the component never silently turns a blocked step into a click.
 */
export function BrowserReplayPreview({
  plan,
  onPreview,
  onStep,
  onRun,
  onClose,
  busy = false,
  outcome
}: {
  plan: BrowserReplayPlan
  onPreview?: () => void
  onStep?: (sequence: number) => void
  onRun?: () => void
  onClose?: () => void
  busy?: boolean
  outcome?: BrowserScriptRunReport['outcome']
}) {
  const blockedCount = plan.steps.filter((step) => Boolean(step.blockedReason)).length
  return (
    <section className="browser-rsi-replay" data-operation-id={plan.operationId} aria-label="Browser replay preview">
      <header className="browser-rsi-replay__header">
        <span><RotateCcw size={14} aria-hidden="true" /><strong>Replay preview</strong><small>{plan.steps.length} {plan.steps.length === 1 ? 'semantic step' : 'semantic steps'}</small></span>
        {onClose ? <button type="button" className="browser-rsi-icon-button" aria-label="Close replay preview" title="Close" onClick={onClose}>×</button> : null}
      </header>
      <p className="browser-rsi-replay__origin"><code>{plan.url}</code>{blockedCount > 0 ? <span className="browser-rsi-replay__blocked">{blockedCount} needs review</span> : null}</p>
      <ol className="browser-rsi-replay__steps">
        {plan.steps.map((step, index) => {
          const sequence = index + 1
          const label = step.target ? targetLabel(step.target) : step.method
          return (
            <li key={`${sequence}-${step.method}`} className={step.blockedReason ? 'is-blocked' : undefined}>
              <span className="browser-rsi-replay__step-number">{sequence}</span>
              <span><strong>{label}</strong><small>{step.inputKey ? `Requires ${step.inputKey}` : step.blockedReason ?? step.method}</small></span>
              {onStep ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet browser-rsi-replay__step-button" disabled={busy || Boolean(step.blockedReason)} aria-label={`Run replay step ${sequence}`} title={step.blockedReason ?? 'Run this step'} onClick={() => onStep(sequence)}><Play size={11} aria-hidden="true" />Run step</button> : null}
            </li>
          )
        })}
      </ol>
      {outcome && outcome.kind !== 'completed' ? <p className={`browser-rsi-replay__outcome browser-rsi-replay__outcome--${outcome.kind}`} role="status"><CircleAlert size={12} aria-hidden="true" /><strong>{replayOutcomeLabel(outcome.kind)}</strong><span>{outcome.message}</span></p> : null}
      <footer className="browser-rsi-replay__actions">
        {onPreview ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={busy} onClick={onPreview}><LoaderCircle className={busy ? 'browser-rsi-spin' : undefined} size={12} aria-hidden="true" />{busy ? 'Preparing…' : 'Preview page'}</button> : null}
        {onRun ? <button type="button" className="browser-rsi-button browser-rsi-button--primary" disabled={busy || blockedCount > 0} title={blockedCount > 0 ? 'Resolve blocked steps before running' : 'Run replay'} onClick={onRun}><Play size={12} aria-hidden="true" />Run replay</button> : null}
      </footer>
    </section>
  )
}

export function phaseLabel(phase: BrowserOperationPhase): string {
  switch (phase) {
    case 'preparing': return 'Preparing operation'
    case 'running': return 'Operating page'
    case 'waiting': return 'Waiting for page'
    case 'human': return 'Human has control'
    case 'completed': return 'Completed'
    case 'failed': return 'Failed'
    case 'indeterminate': return 'Needs review'
    case 'stopped': return 'Stopped'
  }
}

export function formatClock(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function currentTarget(operation: BrowserOperation): string | null {
  const step = [...operation.steps].reverse().find((candidate) => candidate.status === 'running' || candidate.status === 'completed')
  return targetLabel(step?.target)
}

function targetLabel(target: BrowserOperationStep['target']): string | null {
  if (!target) return null
  const position = target.count > 1 ? ` · ${target.ordinal}/${target.count}` : ''
  return `${target.role} “${target.name}”${position}`
}

function replayOutcomeLabel(kind: Exclude<BrowserScriptRunReport['outcome']['kind'], 'completed'>): string {
  switch (kind) {
    case 'script-failed': return 'Replay failed'
    case 'stopped': return 'Replay stopped'
    case 'indeterminate': return 'Replay needs review'
  }
}

function PhaseGlyph({ phase }: { phase: BrowserOperationPhase }) {
  if (phase === 'running') return <SemanticIcon name="working" size={13} />
  if (phase === 'preparing') return <LoaderCircle className="browser-rsi-spin" size={13} aria-hidden="true" />
  if (phase === 'waiting') return <Pause size={13} aria-hidden="true" />
  if (phase === 'human') return <UserRound size={13} aria-hidden="true" />
  if (phase === 'completed') return <CheckCircle2 size={13} aria-hidden="true" />
  if (phase === 'failed') return <CircleX size={13} aria-hidden="true" />
  return <CircleAlert size={13} aria-hidden="true" />
}

function StepGlyph({ status }: { status: BrowserOperationStep['status'] }) {
  if (status === 'running') return <LoaderCircle className="browser-rsi-spin" size={11} aria-hidden="true" />
  if (status === 'completed') return <CheckCircle2 size={11} aria-hidden="true" />
  if (status === 'failed') return <CircleX size={11} aria-hidden="true" />
  return <Hand size={11} aria-hidden="true" />
}
