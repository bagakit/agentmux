import { Bot, ChevronRight, CircleDot, Hammer, Info, ShieldAlert, UserRound } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import type { AgentTimelineItem } from '../../../shared/contracts'

function Glyph({ kind, size = 12 }: { kind: AgentTimelineItem['kind']; size?: number }) {
  if (kind === 'user_message') return <UserRound size={size} />
  if (kind === 'assistant_message') return <Bot size={size} />
  if (kind === 'tool_call') return <Hammer size={size} />
  if (kind === 'permission') return <ShieldAlert size={size} />
  return <CircleDot size={size} />
}

/**
 * The two turns a person actually reads — what they typed and what the agent said back. They are carved
 * out of the machine Row/fold path (see {@link segment}) so a sentence never wears the same 24px log
 * rhythm as a lifecycle hook firing.
 */
function isTurn(kind: AgentTimelineItem['kind']): boolean {
  return kind === 'user_message' || kind === 'assistant_message'
}

/** Offset from the first event. Tabular numerals keep the gutter from shifting as it ticks. */
function formatOffset(createdAt: number, origin: number): string {
  const ms = Math.max(0, createdAt - origin)
  if (ms < 1_000) return `+${ms}ms`
  if (ms < 60_000) return `+${(ms / 1_000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `+${minutes}m${String(Math.floor((ms % 60_000) / 1_000)).padStart(2, '0')}s`
}

/**
 * A run of consecutive machine-reported steps between two turns the user can read. Collapsing the run
 * is the second level of folding: level one expands one step's payload, level two hides the whole
 * stretch of lifecycle noise that sits between a prompt and its answer.
 */
type Segment =
  | { kind: 'item'; item: AgentTimelineItem }
  | { kind: 'run'; id: string; items: AgentTimelineItem[] }

function segment(items: AgentTimelineItem[]): Segment[] {
  const segments: Segment[] = []
  let run: AgentTimelineItem[] = []
  const flush = (): void => {
    if (run.length === 0) return
    // A single hook step is cheaper to read inline than behind a disclosure.
    if (run.length === 1) segments.push({ kind: 'item', item: run[0]! })
    else segments.push({ kind: 'run', id: `run-${run[0]!.id}`, items: run })
    run = []
  }
  for (const item of items) {
    // A run holds machine reporting only. user_message already breaks it (source 'user'); the assistant
    // reply is native-hook too, so without the kind guard segment() would sweep it into a collapsed
    // "N steps" fold and hide the agent's half of the conversation.
    if (item.source === 'native-hook' && !isTurn(item.kind)) run.push(item)
    else {
      flush()
      segments.push({ kind: 'item', item })
    }
  }
  flush()
  return segments
}

/** Identical repeats inside a run collapse to one line with a count, so a retry loop reads as one fact. */
function tally(items: AgentTimelineItem[]): Array<{ item: AgentTimelineItem; count: number }> {
  const rows: Array<{ item: AgentTimelineItem; count: number }> = []
  for (const item of items) {
    const previous = rows[rows.length - 1]
    if (
      previous &&
      previous.item.kind === item.kind &&
      previous.item.title === item.title &&
      previous.item.toolInput === item.toolInput
    ) {
      previous.count += 1
      continue
    }
    rows.push({ item, count: 1 })
  }
  return rows
}

function Ruler({ items, origin, span }: { items: AgentTimelineItem[]; origin: number; span: number }) {
  // With no spread between the first and last event there is no honest time to map, so the axis falls
  // back to even ordinal spacing and says so with a dashed rail — otherwise every tick would stack on
  // the left edge and read as a single event.
  const axis = span > 0 ? 'temporal' : 'ordinal'
  const position = (item: AgentTimelineItem, index: number): number => {
    if (items.length <= 1) return 0
    return axis === 'temporal'
      ? ((item.createdAt - origin) / span) * 100
      : (index / (items.length - 1)) * 100
  }

  return (
    <div className="activity-ruler">
      <div className="activity-ruler__track" data-axis={axis} aria-hidden="true">
        <span className="activity-ruler__rail" />
        {items.map((item, index) => (
          <span
            key={item.id}
            className={`activity-ruler__tick activity-ruler__tick--${item.kind}`}
            data-status={item.status}
            title={`${new Date(item.createdAt).toLocaleTimeString()} · ${item.title}`}
            style={{ left: `${position(item, index)}%` }}
          />
        ))}
      </div>
      <span className="activity-ruler__span">{formatOffset(origin + span, origin)}</span>
      <span
        className="activity-ruler__note"
        title="Structured Session activity only · never Terminal output or private chain-of-thought"
      >
        <Info size={12} />
      </span>
    </div>
  )
}

function Row({
  item,
  origin,
  count,
  showSource
}: {
  item: AgentTimelineItem
  origin: number
  count: number
  showSource: boolean
}) {
  const [open, setOpen] = useState(false)
  // What the agent said is the content of the trace; what a tool was invoked with is its payload.
  // Prose stays on the page, machine arguments fold away — that is the noise the run view is hiding.
  const prose = item.kind === 'tool_call' ? undefined : item.content
  const payload = item.toolInput ?? (item.kind === 'tool_call' ? item.content : undefined)
  const expandable = Boolean(payload)

  return (
    <Fragment>
      {expandable ? (
        <button
          type="button"
          className={`log-row log-row--${item.kind}`}
          data-status={item.status}
          data-expandable=""
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="log-row__node"><Glyph kind={item.kind} /></span>
          <span className="log-row__time">{formatOffset(item.createdAt, origin)}</span>
          <span className="log-row__title">
            {item.title}
            {count > 1 ? <span className="log-row__count">×{count}</span> : null}
          </span>
          <span className="log-row__meta">
            {item.status === 'streaming' ? <span className="log-row__chip">Streaming</span> : null}
            {item.status === 'failed' ? <span className="log-row__chip log-row__chip--failed">Failed</span> : null}
            <span className="log-row__source" data-persistent={showSource ? '' : undefined}>{item.source}</span>
            <ChevronRight size={12} className="log-row__chevron" data-open={open ? '' : undefined} />
          </span>
        </button>
      ) : (
        <div className={`log-row log-row--${item.kind}`} data-status={item.status}>
          <span className="log-row__node"><Glyph kind={item.kind} /></span>
          <span className="log-row__time">{formatOffset(item.createdAt, origin)}</span>
          <span className="log-row__title">
            {item.title}
            {count > 1 ? <span className="log-row__count">×{count}</span> : null}
          </span>
          <span className="log-row__meta">
            {item.status === 'streaming' ? <span className="log-row__chip">Streaming</span> : null}
            {item.status === 'failed' ? <span className="log-row__chip log-row__chip--failed">Failed</span> : null}
            <span className="log-row__source" data-persistent={showSource ? '' : undefined}>{item.source}</span>
          </span>
        </div>
      )}
      {prose ? <p className="log-row__prose">{prose}</p> : null}
      {open && payload ? <pre className="log-row__payload">{payload}</pre> : null}
    </Fragment>
  )
}

/**
 * A readable conversation turn — the second register threaded on the same spine as the machine Row. It
 * shares the log's 20px node hole-punch so chronology is unbroken, but the substance is the words: the
 * caption is a quiet speaker tag, and the body is the largest, brightest text in the view. Never folded,
 * always on screen. This is the register the machine Row deliberately is not.
 */
function Turn({ item, origin }: { item: AgentTimelineItem; origin: number }) {
  const who = item.kind === 'user_message' ? 'You' : 'Assistant'
  return (
    <div className={`log-turn log-turn--${item.kind}`} data-status={item.status}>
      <span className="log-turn__node"><Glyph kind={item.kind} size={14} /></span>
      <div className="log-turn__head">
        <span className="log-turn__who">{who}</span>
        {item.status === 'streaming' ? <span className="log-row__chip">Streaming</span> : null}
        {item.status === 'failed' ? <span className="log-row__chip log-row__chip--failed">Failed</span> : null}
        <span className="log-turn__time">{formatOffset(item.createdAt, origin)}</span>
      </div>
      {item.content ? <p className="log-turn__body">{item.content}</p> : null}
    </div>
  )
}

function Run({ items, origin }: { items: AgentTimelineItem[]; origin: number }) {
  const [open, setOpen] = useState(false)
  const rows = useMemo(() => tally(items), [items])
  const failed = items.some((item) => item.status === 'failed')

  return (
    <Fragment>
      <button
        type="button"
        className="log-fold"
        data-open={open ? '' : undefined}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="log-fold__node"><ChevronRight size={12} className="log-fold__chevron" /></span>
        <span className="log-row__time">{formatOffset(items[0]!.createdAt, origin)}</span>
        <span className="log-fold__label">
          {items.length} steps
          {rows.length < items.length ? <span className="log-row__count">{rows.length} unique</span> : null}
          {failed ? <span className="log-row__chip log-row__chip--failed">FAILED</span> : null}
        </span>
      </button>
      {open
        ? rows.map(({ item, count }, index) => (
            <Row key={item.id} item={item} origin={origin} count={count} showSource={index === 0} />
          ))
        : null}
    </Fragment>
  )
}

export function ActivityView({
  items,
  capability
}: {
  items: AgentTimelineItem[]
  capability: 'unavailable' | 'complete-events' | 'streaming'
}) {
  const segments = useMemo(() => segment(items), [items])
  const origin = items[0]?.createdAt ?? 0
  const span = Math.max(0, (items[items.length - 1]?.createdAt ?? origin) - origin)

  if (capability === 'unavailable') {
    return (
      <div className="activity-feed">
        <div className="activity-feed__empty">
          This executor does not provide structured activity. Terminal remains available.
        </div>
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <div className="activity-feed">
        <div className="activity-feed__empty">
          No structured activity yet. Terminal remains available.
        </div>
      </div>
    )
  }

  return (
    <div className="activity-feed">
      <Ruler items={items} origin={origin} span={span} />
      <div className="activity-log">
        {segments.map((entry) =>
          entry.kind === 'run' ? (
            <Run key={entry.id} items={entry.items} origin={origin} />
          ) : isTurn(entry.item.kind) ? (
            <Turn key={entry.item.id} item={entry.item} origin={origin} />
          ) : (
            <Row key={entry.item.id} item={entry.item} origin={origin} count={1} showSource />
          )
        )}
      </div>
    </div>
  )
}
