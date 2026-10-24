import { useEffect, useMemo, useState, type RefObject, type ReactNode } from 'react'
import { Ruler } from './ConversationRuler'
import { ConversationRulerControls } from './ConversationRulerControls'
import { ConversationAxis, type DescribeSpeaker } from './ConversationAxis'
import { conversationRulerWindow, type RulerRecord, type RulerWindow } from '../lib/conversation-ruler'
import { rulerBand } from '../lib/activity-ruler'
import { useConversationKeyframes } from '../lib/use-conversation-keyframes'
import type { projectAgentActivityHistory } from '@agentmux/core/timeline'
import type { ConversationProcessMember } from '@agentmux/client-ui/components/ConversationRecordSequence'

export type ConversationVisibleShells = { feed: HTMLDivElement; sessionId: string; shells: Set<Element> }

/** Visibility updates belong to the ruler, not to the message rendering owner. */
export function ConversationReadingRuler({ feedEl, sessionId, readingEnabled, rulerRecords, placed,
  visibleShells, rulerWindow, onWindow, selectedRecordId, selectRulerRecord, hasMore, pending, activity, describeSpeaker, tools }: {
  feedEl: HTMLDivElement | null
  sessionId: string
  readingEnabled: boolean
  rulerRecords: readonly RulerRecord[]
  placed: readonly { key: string; from: number; to: number }[]
  visibleShells: RefObject<ConversationVisibleShells | null>
  rulerWindow: RulerWindow
  onWindow: (window: RulerWindow) => void
  selectedRecordId: string | null
  selectRulerRecord: (record: RulerRecord) => void
  hasMore: boolean | undefined
  pending: boolean
  activity: ReturnType<typeof projectAgentActivityHistory>['segments']
  describeSpeaker: DescribeSpeaker | undefined
  tools: ReactNode
}) {
  const [visible, setVisible] = useState<Set<string>>(new Set())
  const keyframes = useConversationKeyframes(feedEl, sessionId, readingEnabled, rulerRecords)
  const ruler = useMemo(() => conversationRulerWindow(rulerRecords, rulerWindow, visible), [rulerRecords, rulerWindow, visible])
  const rulerSelectedIndex = ruler.items.findIndex(record => record.id === selectedRecordId)
  const scale = ruler.scale
  const band = useMemo(() => {
    const indices = ruler.items.flatMap((record, index) => visible.has(record.id) ? [index] : [])
    return rulerBand(scale, indices.length ? { from: Math.min(...indices), to: Math.max(...indices) } : null)
  }, [ruler.items, scale, visible])
  // Retain confirmed DOM visibility through observation handoff, never message bodies.
  // Register committed shells once. Disclosure registers only added descendants, never a scroll-frame scan.
  useEffect(() => {
    if (!readingEnabled || !feedEl) return
    const expected = new Map<string, string[]>()
    const recordIds = new Set(rulerRecords.map(record => record.id))
    const segmentsByIndex = new Map<number, string>()
    for (const segment of placed) for (let index = segment.from; index <= segment.to; index++) segmentsByIndex.set(index, segment.key)
    for (const record of rulerRecords) {
      const target = record.target
      const key = target.kind === 'native' ? JSON.stringify([target.source, target.recordId]) : segmentsByIndex.get(target.index)
      if (key) { const ids = expected.get(key) ?? []; ids.push(record.id); expected.set(key, ids) }
    }
    const mapping = new Map<Element, readonly string[]>()
    const previous = visibleShells.current
    const onscreen = previous?.feed === feedEl && previous.sessionId === sessionId ? previous.shells : new Set<Element>()
    visibleShells.current = { feed: feedEl, sessionId, shells: onscreen }
    let active = true
    const recompute = (): void => {
      if (!active) return
      const next = new Set([...onscreen].flatMap(el => mapping.get(el) ?? []))
      setVisible(current => current.size === next.size && [...current].every(id => next.has(id)) ? current : next)
    }
    const ruler = feedEl.querySelector<HTMLElement>('.activity-ruler')
    let headerHeight = -1
    let observer: IntersectionObserver
    function observeViewport(): void {
      if (!active) return
      const height = Math.ceil(ruler?.getBoundingClientRect().height ?? 0)
      if (height === headerHeight) return
      headerHeight = height
      observer?.disconnect()
      const current = new IntersectionObserver(entries => {
        if (!active || observer !== current) return
        for (const entry of entries) entry.isIntersecting ? onscreen.add(entry.target) : onscreen.delete(entry.target)
        recompute()
      }, { root: feedEl, rootMargin: `-${height}px 0px 0px 0px`, threshold: 0 })
      observer = current
      for (const node of mapping.keys()) observer.observe(node)
    }
    observeViewport()
    const resize = new ResizeObserver(observeViewport)
    if (ruler) resize.observe(ruler)
    function unregister(node: Element): void {
      observer.unobserve(node)
      mapping.delete(node)
      onscreen.delete(node)
    }
    function register(node: HTMLElement): void {
      const id = node.dataset.nativeRecordId ?? node.dataset.nativeStepId
      const source = node.closest<HTMLElement>('[data-native-source]')?.dataset.nativeSource
      const key = id && source ? JSON.stringify([source, id]) : node.dataset.segmentKey
      // Only a folded header represents the group's records. Expanded steps keep their own visibility.
      const group = node.matches('.wf-head[aria-expanded="false"]') ? node.closest<HTMLElement>('[data-conversation-process-members]') : null
      const records = group
        ? (JSON.parse(group.dataset.conversationProcessMembers!) as ConversationProcessMember[]).flatMap(member => recordIds.has(member.id) ? [member.id] : [])
        : key ? expected.get(key) : undefined
      if (!records?.length) { unregister(node); return }
      mapping.set(node, records)
      observer.observe(node)
    }
    const selector = '[data-native-record-id], [data-native-step-id], [data-segment-key], [data-conversation-process-members] .wf-head'
    feedEl.querySelectorAll<HTMLElement>(selector).forEach(register)
    for (const node of onscreen) if (!mapping.has(node) || !node.isConnected) onscreen.delete(node)
    recompute()
    const mutations = new MutationObserver(entries => {
      if (!active) return
      for (const entry of entries) {
        if (entry.type === 'attributes' && entry.target instanceof HTMLElement && entry.target.matches('[data-conversation-process-members] .wf-head')) register(entry.target)
        for (const added of entry.addedNodes) if (added instanceof HTMLElement) {
          if (added.matches(selector)) register(added)
          added.querySelectorAll<HTMLElement>(selector).forEach(register)
        }
        for (const removed of entry.removedNodes) if (removed instanceof HTMLElement) {
          if (removed.matches(selector)) unregister(removed)
          removed.querySelectorAll(selector).forEach(unregister)
        }
      }
      recompute()
    })
    mutations.observe(feedEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
    return () => { active = false; mutations.disconnect(); resize.disconnect(); observer.disconnect() }
  }, [rulerRecords, placed, feedEl, sessionId, readingEnabled])
  return <Ruler visible={readingEnabled}
        items={ruler.items}
        scale={scale}
        selectedIndex={rulerSelectedIndex < 0 ? null : rulerSelectedIndex}
        band={band}
        {...(hasMore === undefined ? {} : { reading: { hasMore } })}
        pending={pending}
        recentFraction={ruler.recentFraction}
        activity={activity}
        controls={close => <><ConversationRulerControls window={rulerWindow} onWindow={onWindow}
          untimed={ruler.untimed} onSelect={selectRulerRecord} describe={describeSpeaker ?? (() => ({ name: 'Recorded input' }))}
          onOpen={() => { close() }} />{tools}</>}
        onSelect={index => selectRulerRecord(ruler.items[index]!)}
        axes={({ width, onPeek, onPeekEnd }) =>
          describeSpeaker ? (
            <ConversationAxis items={ruler.items} belongs={() => true} width={width}
              keyframes={keyframes}
              label="Participants" size={16} describe={describeSpeaker}
              conversationSessionId={sessionId} recentFraction={ruler.recentFraction}
              selectedIndex={rulerSelectedIndex < 0 ? null : rulerSelectedIndex}
              onSelect={index => selectRulerRecord(ruler.items[index]!)} onPeek={onPeek} onPeekEnd={onPeekEnd} />
          ) : null
        }
      />
}
