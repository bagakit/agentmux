import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
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
import { useId, useState } from 'react'
import type {
  BrowserActivityState,
  BrowserOperation,
  BrowserOperationPhase,
  BrowserOperationStep,
  BrowserReplayPlan
} from '../../../shared/browser-operation'
import type { BrowserScriptRunReport } from '../../../shared/contracts'
import { SemanticIcon } from './semantic-icons'
import * as DropdownMenu from './HoverDropdownMenu'

/** One toolbar disclosure owns Browser operation state and its optional actions. */
export function BrowserOperationStatus({
  activity,
  onTakeControl,
  onReturnControl,
  onStop,
  onOpenTimeline,
  onOpenChange
}: {
  activity: BrowserActivityState
  onTakeControl?: () => void
  onReturnControl?: () => void
  onStop?: () => void
  onOpenTimeline?: () => void
  onOpenChange?: (open: boolean) => void
}) {
  const operation = activity.operation
  const terminal = operation && ['completed', 'failed', 'stopped', 'indeterminate'].includes(operation.phase)
  const phase = operation
    ? !terminal && activity.control === 'human' ? 'human' : operation.phase
    : activity.control === 'agent' ? 'unknown' : 'idle'
  const label = phase === 'unknown' ? 'Agent control active · Activity details are loading'
    : phase === 'idle' ? 'You have control' : phaseLabel(phase)
  const target = operation ? currentTarget(operation) ?? operation.summary : null
  const description = [operation?.operator.name, label, target].filter(Boolean).join(' · ')
  const canStop = Boolean(operation && !terminal)
  const canTakeControl = canStop && activity.control === 'agent'
  const canReturnControl = canStop && activity.control === 'human'
  return (
    <span className="browser-operation-status" data-phase={phase} data-control={activity.control} data-operation-id={operation?.id}>
      <DropdownMenu.Root {...(onOpenChange ? { onOpenChange } : {})}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="browser-operation-status__trigger" aria-label={`Browser activity: ${description}`} title={description}>
            {phase === 'idle' ? <History size={14} aria-hidden="true" />
              : phase === 'unknown' ? <CircleAlert size={14} aria-hidden="true" /> : <PhaseGlyph phase={phase} />}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="browser-menu browser-operation-menu" align="end" sideOffset={5} collisionPadding={8}>
            <DropdownMenu.Label className="browser-operation-menu__identity">
              <strong>{operation?.operator.name ?? 'Browser activity'}</strong><span>{label}</span>
              {target ? <small>{target}</small> : null}
            </DropdownMenu.Label>
            {canTakeControl && onTakeControl ? <DropdownMenu.Item className="browser-menu__item" onSelect={() => onTakeControl()}><Hand size={13} aria-hidden="true" /><span>Take control</span></DropdownMenu.Item> : null}
            {canReturnControl && onReturnControl ? <DropdownMenu.Item className="browser-menu__item" onSelect={() => onReturnControl()}><RotateCcw size={13} aria-hidden="true" /><span>Return to Agent</span></DropdownMenu.Item> : null}
            {canStop && onStop ? <DropdownMenu.Item className="browser-menu__item" aria-label="Stop browser operation" onSelect={() => onStop()}><Square size={12} aria-hidden="true" /><span>Stop operation</span></DropdownMenu.Item> : null}
            {onOpenTimeline ? <DropdownMenu.Item className="browser-menu__item" aria-label="Open browser activity timeline" onSelect={() => onOpenTimeline()}><History size={13} aria-hidden="true" /><span>Activity</span></DropdownMenu.Item> : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  )
}

/** Persistent service notice is separate from the optional operation disclosure. */
export function BrowserOperationWarning({ activity }: { activity: BrowserActivityState }) {
  const message = activity.operation?.warning ?? activity.warning
  return message ? <BrowserOperationNotice message={message} className="browser-operation-warning" /> : null
}

/**
 * A timeline that carries operation facts, rather than a second stream of inferred Agent thinking.
 * A step may be selected for a target highlight or replay preview; both affordances are optional so
 * the read-only timeline stays a real read-only surface when the host has no handler yet.
 */
export function BrowserOperationTimeline({
  operation,
  warning,
  selectedSequence,
  onSelectStep,
  onReplay
}: {
  operation: BrowserOperation | null
  warning?: string
  selectedSequence?: number
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
      {operation.warning || warning ? <BrowserOperationNotice message={(operation.warning ?? warning)!} className="browser-rsi-timeline__warning" /> : null}
      <ol className="browser-rsi-timeline__list">
        {operation.steps.length === 0 ? <li className="browser-rsi-timeline__empty">Waiting for the first observed action…</li> : operation.steps.map((step) => (
          <BrowserStepRow key={`${operation.id}-${step.sequence}-${step.startedAt}`} step={step}
            selected={selectedSequence === step.sequence} {...(onSelectStep ? { onSelectStep } : {})} />
        ))}
      </ol>
    </section>
  )
}

function BrowserOperationNotice({ message, className }: { message: string; className: string }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  // The first reported line is the cause/recovery text. Stack traces remain exact and reachable,
  // without filling both the page rail and its timeline before the person asks for diagnostics.
  const summary = message.split('\n')[0] ?? message
  const hasDetails = summary !== message
  return <div className={`${className} browser-rsi-notice`} role="status">
    <span className="browser-rsi-notice__line"><CircleAlert size={12} aria-hidden="true" /><span>{summary}</span>
      {hasDetails ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet"
        aria-label="Show browser warning details" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>Details</button> : null}
    </span>
    {open ? <pre id={panelId}>{message}</pre> : null}
  </div>
}

function BrowserStepRow({ step, selected, onSelectStep }: {
  step: BrowserOperationStep; selected: boolean; onSelectStep?: (step: BrowserOperationStep) => void
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const target = targetLabel(step.target)
  return (
    <li className={`browser-rsi-timeline__step browser-rsi-timeline__step--${step.status}${selected ? ' is-selected' : ''}`} data-sequence={step.sequence}>
      <button type="button" className="browser-rsi-timeline__step-button" aria-label={`Inspect step ${step.sequence}: ${step.label}`}
        aria-expanded={open} aria-controls={panelId} aria-pressed={selected}
        onClick={() => { setOpen(!open); onSelectStep?.(step) }}>
        <span className="browser-rsi-timeline__marker" aria-hidden="true"><StepGlyph status={step.status} /></span>
        <span className="browser-rsi-timeline__step-content" title={[step.label, target].filter(Boolean).join(' · ')}>
          <strong>{step.label}</strong>
          {target ? <span className="browser-rsi-timeline__target">{target}</span> : null}
        </span>
        <span className="browser-rsi-timeline__status">{step.status}</span>
        <ChevronRight className="browser-rsi-timeline__chevron" size={11} aria-hidden="true" />
      </button>
      {open ? <div id={panelId} className="browser-rsi-timeline__step-detail">
        <span><code>{step.method}</code><time>{formatClock(step.startedAt)}</time></span>
        {step.summary ? <p>{step.summary}</p> : null}
      </div> : null}
    </li>
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
        {onPreview ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={busy} onClick={onPreview}><LoaderCircle className={busy ? 'spin' : undefined} size={12} aria-hidden="true" />{busy ? 'Preparing…' : 'Preview page'}</button> : null}
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
  if (phase === 'preparing') return <LoaderCircle className="spin" size={13} aria-hidden="true" />
  if (phase === 'waiting') return <Pause size={13} aria-hidden="true" />
  if (phase === 'human') return <UserRound size={13} aria-hidden="true" />
  if (phase === 'completed') return <CheckCircle2 size={13} aria-hidden="true" />
  if (phase === 'failed') return <CircleX size={13} aria-hidden="true" />
  return <CircleAlert size={13} aria-hidden="true" />
}

function StepGlyph({ status }: { status: BrowserOperationStep['status'] }) {
  if (status === 'running') return <LoaderCircle className="spin" size={11} aria-hidden="true" />
  if (status === 'completed') return <CheckCircle2 size={11} aria-hidden="true" />
  if (status === 'failed') return <CircleX size={11} aria-hidden="true" />
  return <Hand size={11} aria-hidden="true" />
}
