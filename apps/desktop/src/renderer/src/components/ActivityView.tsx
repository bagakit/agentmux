import { Bot, ChevronRight, CircleDot, Hammer, Info, ShieldAlert, UserRound } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentTimelineItem } from '../../../shared/contracts'
import {
  createRulerScale,
  describeReadout,
  describeRulerAxis,
  formatOffset,
  rulerBand,
  stepRulerSelection,
  type RulerReadoutText,
  type RulerScale
} from '../lib/activity-ruler'
import { terminalLinkPreviewAnchor } from '../lib/terminal-link-gesture'
import { AgentMarkdown } from './AgentMarkdown'

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

/** The client-space rectangle the readout must stay clear of and inside — the whole ruler track. */
function readoutAnchor(
  trackRect: DOMRect,
  feedRect: DOMRect,
  pointerX: number
): { left: number; top: number; placement: 'above' | 'below' } {
  // Reuse the exact anchoring the terminal link preview established: clear a full "cell" (here, half
  // the track height from its centre) plus the gap so the readout never covers the segment it
  // describes, and flip below when there is no room above. Keeping one implementation means the two
  // hovering surfaces can never drift apart on where "not covering the thing" lands.
  return terminalLinkPreviewAnchor({
    pointer: { x: pointerX, y: trackRect.top + trackRect.height / 2 },
    cellHeight: trackRect.height / 2,
    viewport: {
      left: feedRect.left,
      top: feedRect.top,
      right: feedRect.right,
      bottom: feedRect.bottom
    }
  })
}

type Readout = {
  text: RulerReadoutText
  left: number
  top: number
  placement: 'above' | 'below'
}

/**
 * The interactive temporal axis. Ticks sit at their real elapsed fraction (or even ordinal spacing
 * when there is no spread to map). It is one focusable slider: click or keyboard both resolve a
 * position to a real event through the shared {@link RulerScale} and ask the log to scroll there;
 * hover and focus read the same scale for the moment (or ordinal) at a position without ever moving
 * the selection.
 */
function Ruler({
  items,
  scale,
  selectedIndex,
  band,
  onSelect
}: {
  items: AgentTimelineItem[]
  scale: RulerScale
  selectedIndex: number | null
  band: ReturnType<typeof rulerBand>
  onSelect: (index: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [readout, setReadout] = useState<Readout | null>(null)
  const axisLabel = describeRulerAxis(scale)

  const feedRect = (): DOMRect | null =>
    trackRef.current?.closest('.activity-feed')?.getBoundingClientRect() ?? null

  const showReadout = (index: number, pointerX: number): void => {
    const track = trackRef.current
    const feed = feedRect()
    if (!track || !feed) return
    const trackRect = track.getBoundingClientRect()
    const anchor = readoutAnchor(trackRect, feed, pointerX)
    setReadout({ text: describeReadout(scale.readoutOf(index), scale.count), ...anchor })
  }

  const fractionFromClientX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return (clientX - rect.left) / rect.width
  }

  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const readoutAt = scale.readoutAtFraction(fractionFromClientX(event.clientX))
    if (readoutAt) onSelect(readoutAt.index)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const at = scale.readoutAtFraction(fractionFromClientX(event.clientX))
    if (at) showReadout(at.index, event.clientX)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = stepRulerSelection(selectedIndex, event.key, scale.count)
    if (next === null || next === selectedIndex) {
      // Home/End with an existing selection can equal current; still consume the navigation keys so
      // the surrounding scroll container does not also act on them.
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
      }
      return
    }
    event.preventDefault()
    onSelect(next)
    // Focus keeps the same readout the pointer would show, anchored over the newly selected tick.
    const track = trackRef.current
    if (track) {
      const rect = track.getBoundingClientRect()
      showReadout(next, rect.left + scale.fractionOf(next) * rect.width)
    }
  }

  const handleFocus = (): void => {
    if (selectedIndex === null) return
    const track = trackRef.current
    if (track) {
      const rect = track.getBoundingClientRect()
      showReadout(selectedIndex, rect.left + scale.fractionOf(selectedIndex) * rect.width)
    }
  }

  const selectedText =
    selectedIndex === null ? undefined : describeReadout(scale.readoutOf(selectedIndex), scale.count).summary

  return (
    <div className="activity-ruler">
      <div
        ref={trackRef}
        className="activity-ruler__track"
        data-axis={scale.axis}
        role="slider"
        tabIndex={0}
        aria-label={axisLabel}
        aria-valuemin={1}
        aria-valuemax={scale.count}
        aria-valuenow={(selectedIndex ?? 0) + 1}
        aria-valuetext={selectedText ?? axisLabel}
        onClick={handleClick}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setReadout(null)}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={() => setReadout(null)}
      >
        <span className="activity-ruler__rail" />
        {band ? (
          <span
            className="activity-ruler__band"
            data-axis={scale.axis}
            style={{ left: `${band.startFraction * 100}%`, right: `${(1 - band.endFraction) * 100}%` }}
            aria-hidden="true"
          />
        ) : null}
        {items.map((item, index) => (
          <span
            key={item.id}
            className={`activity-ruler__tick activity-ruler__tick--${item.kind}`}
            data-status={item.status}
            data-selected={index === selectedIndex ? '' : undefined}
            style={{ left: `${scale.fractionOf(index) * 100}%` }}
          />
        ))}
      </div>
      <span className="activity-ruler__span">{formatOffset(scale.origin + scale.span, scale.origin)}</span>
      <span
        className="activity-ruler__note"
        title="Structured Session activity only · never Terminal output or private chain-of-thought"
      >
        <Info size={12} />
      </span>
      {readout ? (
        <div
          className="activity-ruler__readout"
          data-placement={readout.placement}
          role="status"
          style={{ left: readout.left, top: readout.top }}
        >
          {readout.text.axis === 'temporal' ? (
            <Fragment>
              <span className="activity-ruler__readout-time">
                {new Date(readout.text.at).toLocaleTimeString()}
              </span>
              <span className="activity-ruler__readout-offset">{readout.text.offsetText} from start</span>
            </Fragment>
          ) : (
            <span className="activity-ruler__readout-ordinal">
              Event {readout.text.ordinal} of {readout.text.total}
            </span>
          )}
        </div>
      ) : null}
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
      {/* Only the TURN register renders markdown. The machine Row (log-row__prose) stays plain text: it
          carries payload, not prose someone reads for meaning. */}
      {item.content ? <AgentMarkdown content={item.content} className="log-turn__body" /> : null}
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

/** A segment paired with the half-open range of event indices it covers, so a position on the ruler
 *  can find the row that hosts that event and the band can read which events are on screen. */
type PlacedSegment = { entry: Segment; key: string; from: number; to: number }

function placeSegments(segments: Segment[]): PlacedSegment[] {
  const placed: PlacedSegment[] = []
  let index = 0
  for (const entry of segments) {
    const size = entry.kind === 'run' ? entry.items.length : 1
    const key = entry.kind === 'run' ? entry.id : entry.item.id
    placed.push({ entry, key, from: index, to: index + size - 1 })
    index += size
  }
  return placed
}

export function ActivityView({
  items,
  capability
}: {
  items: AgentTimelineItem[]
  capability: 'unavailable' | 'complete-events' | 'streaming'
}) {
  const segments = useMemo(() => segment(items), [items])
  const placed = useMemo(() => placeSegments(segments), [segments])
  const origin = items[0]?.createdAt ?? 0
  // The scale is the single source both the ruler and the log read from — width is irrelevant to it
  // because every position is expressed as a 0..1 fraction and rendered as a percentage.
  const scale = useMemo(() => createRulerScale(items.map((item) => item.createdAt), 1), [items])

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [visible, setVisible] = useState<{ from: number; to: number } | null>(null)
  const band = useMemo(() => rulerBand(scale, visible), [scale, visible])

  const logRef = useRef<HTMLDivElement>(null)
  // Segment elements keyed by segment key, so a resolved event index can find its host row and the
  // observer can watch each one.
  const segmentEls = useRef(new Map<string, HTMLElement>())

  const segmentForIndex = (index: number): PlacedSegment | undefined =>
    placed.find((entry) => index >= entry.from && index <= entry.to)

  const selectEvent = (index: number): void => {
    setSelectedIndex(index)
    const host = segmentForIndex(index)
    const el = host ? segmentEls.current.get(host.key) : undefined
    // Reuse the same scroll primitive the rest of the app uses to bring a row into view; there is no
    // second scroll controller for the Activity log.
    el?.scrollIntoView({ block: 'nearest' })
  }

  // The visible-range band is driven by an IntersectionObserver, not by a scroll handler: the browser
  // reports crossings when they happen instead of us recomputing layout on every scroll frame. This is
  // what keeps a reading decoration out of the scroll hot path.
  useEffect(() => {
    const root = logRef.current?.closest('.activity-feed')
    if (!(root instanceof HTMLElement)) return
    const onscreen = new Set<string>()
    const ranges = new Map(placed.map((entry) => [entry.key, { from: entry.from, to: entry.to }]))
    const recompute = (): void => {
      let from = Infinity
      let to = -Infinity
      for (const key of onscreen) {
        const range = ranges.get(key)
        if (!range) continue
        from = Math.min(from, range.from)
        to = Math.max(to, range.to)
      }
      setVisible(to >= from ? { from, to } : null)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.segmentKey
          if (!key) continue
          if (entry.isIntersecting) onscreen.add(key)
          else onscreen.delete(key)
        }
        recompute()
      },
      // The sticky ruler occupies the top of the scroll port; discount it so a row hidden behind the
      // ruler is not counted as visible.
      { root, rootMargin: '-34px 0px 0px 0px', threshold: 0 }
    )
    for (const el of segmentEls.current.values()) observer.observe(el)
    return () => observer.disconnect()
  }, [placed])

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

  const registerSegment = (key: string) => (el: HTMLDivElement | null): void => {
    if (el) {
      el.dataset.segmentKey = key
      segmentEls.current.set(key, el)
    } else {
      segmentEls.current.delete(key)
    }
  }

  return (
    <div className="activity-feed">
      <Ruler
        items={items}
        scale={scale}
        selectedIndex={selectedIndex}
        band={band}
        onSelect={selectEvent}
      />
      <div className="activity-log" ref={logRef}>
        {placed.map(({ entry, key, from }) => (
          // One wrapper per segment carries the scroll target, the observer key, and the selection
          // marker, so the three log registers below stay unaware of the ruler wiring.
          <div
            key={key}
            className="activity-log__segment"
            ref={registerSegment(key)}
            data-selected={from === selectedIndex ? '' : undefined}
          >
            {entry.kind === 'run' ? (
              <Run items={entry.items} origin={origin} />
            ) : isTurn(entry.item.kind) ? (
              <Turn item={entry.item} origin={origin} />
            ) : (
              <Row item={entry.item} origin={origin} count={1} showSource />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
