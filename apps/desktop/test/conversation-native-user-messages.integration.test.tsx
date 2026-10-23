// @vitest-environment happy-dom
import { fixturePath, fixtureTime } from '../scripts/lib/fixture-values.mjs'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionHistoryItem,
  AgentSessionHistoryPage,
  AgentSessionUserMessage,
  AgentTimelineItem,
} from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core'
import type { AgentSessionControl } from '../src/shared/contracts'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import {
  UNKNOWN_SPEAKER_ID,
  createSpeakerResolver,
  speakerOfUserMessage,
} from '@agentmux/client-ui/conversation-speaker'
import { speakerOf } from '../src/renderer/src/lib/conversation-speaker'
import { api } from '../src/renderer/src/lib/api'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { activityReadingProps } from './helpers/activity-reading-props'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'

const control: AgentSessionControl = {
  kind: 'agent',
  hostId: 'local',
  agentSessionId: 'agent-session-t036',
  run: { runId: 'run-t036' },
}
const reference = { hostId: control.hostId, agentSessionId: control.agentSessionId }
const originalSource = { providerId: 'claude', nativeSessionId: 'original-native-user-source' }
let host: HTMLDivElement, root: Root
let reading: Awaited<ReturnType<typeof conversationPagePortFixture>> | undefined
const wait = (assertion: () => void) =>
  vi.waitFor(
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      assertion()
    },
    { timeout: 5000, interval: 10 },
  )
const user = (id: string, text: string, startedAt?: number): AgentSessionHistoryItem => ({
  id,
  kind: 'user-message',
  contentParts: [{ kind: 'text', text }],
  ...(startedAt === undefined ? {} : { startedAt }),
})
const captured = (
  id: string,
  kind: AgentTimelineItem['kind'],
  content: string,
  at: number,
  peer?: string,
  status: AgentTimelineItem['status'] = 'complete',
): AgentTimelineItem => ({
  id,
  agentSessionId: reference.agentSessionId,
  kind,
  content,
  title: id,
  source: kind === 'user_message' ? 'user' : 'native-hook',
  status,
  createdAt: at,
  updatedAt: at,
  ...(peer ? { authorAgentSessionId: peer } : {}),
})
const resolver = () =>
  createSpeakerResolver({
    lookupAgent: (id) =>
      ['peer', 'peer-session-id'].includes(id) ? { label: 'Peer Agent', providerId: 'pi' } : undefined,
    currentSession: { id: reference.agentSessionId, label: 'Recipient', providerId: 'claude' },
  })
async function mount(
  items: AgentSessionHistoryItem[],
  capturedItems: AgentTimelineItem[] = [],
  options: { capability?: 'complete-events' | 'unavailable'; source?: AgentSessionHistoryPage['source'] } = {},
) {
  const source = options.source ?? originalSource
  const page: AgentSessionHistoryPage = { ...reference, source, items, nextCursor: null }
  reading = await conversationPagePortFixture(reference, source, async () => page)
  const stream = await reading.publishCaptured(capturedItems)
  await act(async () =>
    root.render(
      <ActivityView
        {...activityReadingProps({ control, workspaceRoot: fixturePath('repo'), describeSpeaker: resolver() })}
        capability={options.capability ?? 'complete-events'}
        displayState="done"
      />,
    ),
  )
  await wait(() => {
    expect(reading!.acceptedCaptured(stream)).toBe(true)
    expect(inspectConversationConsumers(reference).consumers[0]).toMatchObject({
      loading: false,
      inFlight: false,
      accepted: { recordCount: items.length + capturedItems.length },
    })
  })
  expect(reading.nativeRead).toHaveBeenCalled()
}
async function exposeCaptured() {
  for (const button of host.querySelectorAll<HTMLButtonElement>(
    '.conversation-reply-observation__toggle[aria-expanded="false"]',
  ))
    await act(async () => button.click())
  for (const disclosure of host.querySelectorAll<HTMLDetailsElement>(
    '.conversation-submission-record > details:not([open])',
  ))
    await act(async () => {
      disclosure.open = true
      disclosure.dispatchEvent(new Event('toggle'))
    })
}
function turns() {
  return [...host.querySelectorAll<HTMLElement>('.log-turn')]
}
function row(id: string) {
  const native = host.querySelector<HTMLElement>(`[data-native-record-id="${id}"]`)
  const observed = [...host.querySelectorAll<HTMLElement>('[data-conversation-item-ref]')].find(
    (node) => JSON.parse(node.dataset.conversationItemRef!).source.recordId === id,
  )
  const result = native ?? observed
  expect(result, id).toBeDefined()
  const card = result!.matches('.log-turn') ? result : result!.querySelector<HTMLElement>('.log-turn')
  expect(card, id + ' original message card').not.toBeNull()
  return card!
}
const answer = (id: string, text: string, startedAt: number): AgentSessionHistoryItem => ({
  ...user(id, text, startedAt),
  kind: 'assistant-message',
})
async function expectScrolledTo(id: string) {
  const card = row(id),
    shell = card.closest('[data-native-record-id]') ?? card
  await wait(() =>
    expect(
      vi
        .mocked(Element.prototype.scrollIntoView)
        .mock.contexts.some((node) => node instanceof Element && shell.contains(node)),
    ).toBe(true),
  )
}
function currentTrack() {
  const track = host.querySelector<HTMLElement>('.activity-ruler__track')
  expect(track).not.toBeNull()
  return track!
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Element.prototype.scrollIntoView = vi.fn()
  reading = undefined
  host = document.createElement('div')
  document.body.append(host)
  root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  getSelection()?.removeAllRanges()
  try {
    if (reading) expect(reading.controls.map((control) => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
  } finally {
    await reading?.close()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

describe('全来源 user 回合与共享作者的真实公共 Reader 消费', () => {
  it('历史入口读取同一 Core native user 身份和原 parts，不猜 Human/You', async () => {
    const input = {
      ...user('record-native-turn-1', 'Native terminal prompt from user', 10000),
      contentParts: [
        { kind: 'text' as const, text: 'Native terminal prompt from user' },
        { kind: 'resource' as const, resourceType: 'file' as const, reference: 'src/native-entry.ts' },
      ],
    }
    await mount(
      [
        input,
        {
          id: 'record-assistant-turn-1',
          kind: 'assistant-message',
          contentParts: [{ kind: 'text', text: 'Assistant reply' }],
          startedAt: 12000,
        },
      ],
      [],
      { source: { providerId: 'codex', nativeSessionId: 'native-session-1' } },
    )
    expect(turns()).toHaveLength(2)
    const turn = row(input.id)
    expect(turn.dataset.speakerRole).toBe('human')
    expect(turn.querySelector('.log-turn__who')?.textContent).toBe('You')
    expect(turn.querySelector('[role="note"]')).toBeNull()
    expect(turn.querySelector('.conversation-avatar--human')).not.toBeNull()
    expect(turn.querySelector('.conversation-avatar--unknown')).toBeNull()
    expect(turn.querySelector('.log-turn__body')?.textContent).toContain('Native terminal prompt from user')
    const file = turn.querySelector<HTMLElement>('.conversation-resource-file')!
    expect(file).not.toBeNull()
    expect(file.textContent).toContain('Original name unavailable')
    expect(
      turn.querySelector('.log-turn__body p')!.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
    const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined),
      referenceDetails = file.querySelector<HTMLDetailsElement>('.conversation-resource-file__reference')!
    await act(async () => {
      referenceDetails.open = true
      referenceDetails.dispatchEvent(new Event('toggle'))
    })
    const copyReference = file.querySelector<HTMLButtonElement>('[aria-label="Copy file reference"]')!
    expect(copyReference).not.toBeNull()
    await act(async () => copyReference.click())
    expect(clipboard).toHaveBeenCalledExactlyOnceWith('src/native-entry.ts')
    expect(JSON.parse(turn.dataset.conversationItemRef!)).toMatchObject({
      hostId: reference.hostId,
      agentSessionId: reference.agentSessionId,
      source: { kind: 'native', recordId: input.id },
    })
    const page: Awaited<ReturnType<typeof api.conversation.readAgentConversation>> =
      await vi.mocked(api.conversation.readAgentConversation).mock.results.at(-1)!.value
    expect(
      page.items
        .flatMap((entry) => (entry.kind === 'item' ? entry.item.records : []))
        .find((record) => record.original.item.id === input.id)?.original,
    ).toMatchObject({ kind: 'native', item: { kind: 'user-message', contentParts: input.contentParts } })
  })
  it('原生记录缺时间和状态时如实缺席，不补 0、now 或 complete', async () => {
    await mount([user('record-no-time', 'No timestamp prompt')], [], {
      source: { providerId: 'pi', nativeSessionId: 'native-session-pi' },
    })
    expect(turns()).toHaveLength(1)
    const turn = row('record-no-time')
    expect(turn.querySelector('.log-turn__time')).toBeNull()
    expect(turn.getAttribute('data-status')).toBeNull()
    expect(turn.querySelector('.log-row__chip[role="status"]')).toBeNull()
  })
  it('同正文不同原记录经公开投影及实际 Activity 保留两个回合', async () => {
    const items = [
      user('turn-rec-alpha', 'Repeated identical query', 1000),
      user('turn-rec-beta', 'Repeated identical query', 2000),
    ]
    const projected = projectSessionUserMessages({
      agentSessionId: reference.agentSessionId,
      historyPage: { ...reference, source: originalSource, items, nextCursor: null },
    })
    expect(projected).toHaveLength(2)
    expect(projected[0]!.id).not.toBe(projected[1]!.id)
    expect(projected.map((item) => item.rawId)).toEqual(items.map((item) => item.id))
    expect(projected[0]!.content).toBe(projected[1]!.content)
    await mount(items)
    expect(turns()).toHaveLength(2)
    expect(turns().map((turn) => turn.querySelector('.log-turn__body')?.textContent)).toEqual([
      'Repeated identical query',
      'Repeated identical query',
    ])
  })
  it('原生输入与持久 captured peer 原作者均成为可读回合，Hook 回复保原审计来源', async () => {
    await mount(
      [user('msg-1', 'Terminal native prompt', 100)],
      [
        captured('msg-from-peer', 'user_message', 'Message from coworker agent', 200, 'peer-session-id'),
        captured('assistant-reply-1', 'assistant_message', 'Understood', 300),
      ],
    )
    await exposeCaptured()
    expect(turns()).toHaveLength(3)
    expect(row('msg-1').dataset.speakerRole).toBe('human')
    expect(row('msg-1').querySelector('.log-turn__who')?.textContent).toBe('You')
    expect(row('msg-from-peer').dataset.speakerRole).toBe('agent')
    expect(row('msg-from-peer').querySelector('.log-turn__who')?.textContent).toBe('Peer Agent')
    expect(row('msg-from-peer').querySelector('.conversation-avatar--agent')).not.toBeNull()
    expect(row('assistant-reply-1').textContent).toContain('Understood')
    expect(host.querySelectorAll('.log-row')).toHaveLength(0)
  })
  it('实时读取的无时间原生输入同样不产生虚构时间或状态', async () => {
    await mount([user('msg-no-time', 'Timeless native input')], [], {
      source: { providerId: 'pi', nativeSessionId: 'session-1' },
    })
    const turn = row('msg-no-time')
    expect(turn.querySelector('.log-turn__time')).toBeNull()
    expect(turn.getAttribute('data-status')).toBeNull()
    expect(turn.querySelector('.log-row__chip[role="status"]')).toBeNull()
  })
  it('共同 speaker resolver: 按真实 speaker.id 寻址，缺失保原 id，不冒用收件人资料', () => {
    const resolver = createSpeakerResolver({
      lookupAgent: (id) => (id === 'peer-1' ? { label: 'Peer One', providerId: 'codex' } : undefined),
      currentSession: { id: 'current-session-id', label: 'Recipient Agent', providerId: 'claude' },
    })

    // Known peer
    expect(resolver({ role: 'agent', id: 'peer-1' })).toEqual({
      name: 'Peer One',
      providerId: 'codex',
    })

    // Unknown agent: retains speaker.id, does NOT substitute recipient label
    expect(resolver({ role: 'agent', id: 'other-unlisted-agent' })).toEqual({
      name: 'other-unlisted-agent',
    })

    // Unknown input uses the user display default without altering the recorded author.
    expect(resolver({ role: 'unknown', id: UNKNOWN_SPEAKER_ID })).toEqual({
      name: 'You',
    })
  })

  it('speakerOf 与 speakerOfUserMessage: 统一将未知作者判定为 unknown，不猜 Human', () => {
    // 1. From AgentSessionUserMessage
    const unknownNativeMsg: AgentSessionUserMessage = {
      id: 'native:claude:s:1',
      rawId: '1',
      agentSessionId: control.agentSessionId,
      source: { kind: 'native', providerId: 'claude', nativeSessionId: 's', recordId: '1' },
      author: { kind: 'unknown' },
      content: 'hello',
      contentParts: [{ kind: 'text', text: 'hello' }],
    }
    expect(speakerOfUserMessage(unknownNativeMsg)).toEqual({
      role: 'unknown',
      id: UNKNOWN_SPEAKER_ID,
    })
    expect(speakerOf(unknownNativeMsg)).toEqual({
      role: 'unknown',
      id: UNKNOWN_SPEAKER_ID,
    })

    // 2. From known agent user message
    const peerMsg: AgentSessionUserMessage = {
      id: 'captured:2',
      rawId: '2',
      agentSessionId: control.agentSessionId,
      source: { kind: 'captured', submissionId: '2' },
      author: { kind: 'agent', agentSessionId: 'agent-alice' },
      content: 'hello from alice',
      contentParts: [{ kind: 'text', text: 'hello from alice' }],
    }
    expect(speakerOfUserMessage(peerMsg)).toEqual({
      role: 'agent',
      id: 'agent-alice',
    })
    expect(speakerOf(peerMsg)).toEqual({
      role: 'agent',
      id: 'agent-alice',
    })

    // 3. From timeline item with source=user
    const timelineUserItem: AgentTimelineItem = {
      id: 't-1',
      agentSessionId: control.agentSessionId,
      kind: 'user_message',
      status: 'complete',
      source: 'user',
      createdAt: 100,
      updatedAt: 100,
      title: 'Prompt',
    }
    expect(speakerOf(timelineUserItem)).toEqual({
      role: 'unknown',
      id: UNKNOWN_SPEAKER_ID,
    })
  })

  it('native rawId 碰撞不抹除未关联 captured 原记录', async () => {
    await mount(
      [user('raw-shared', 'native body', 100)],
      [
        captured('raw-shared', 'user_message', 'captured unrelated body', 200, 'peer'),
        captured('assistant-1', 'assistant_message', 'assistant reply', 300),
      ],
    )
    await exposeCaptured()
    expect(turns()).toHaveLength(3)
    expect(
      turns()
        .map((turn) => turn.textContent)
        .join('\n'),
    ).toContain('captured unrelated body')
    const refs = turns().map((turn) => JSON.parse(turn.dataset.conversationItemRef!))
    expect(
      refs
        .filter((ref) => ref.source.recordId === 'raw-shared')
        .map((ref) => ref.source.kind)
        .sort(),
    ).toEqual(['captured', 'native'])
  })
  it('公开 captured unverified 不冒充 Failed', async () => {
    await mount([], [captured('pending-msg', 'user_message', 'not confirmed delivery', 100, 'peer', 'streaming')])
    await exposeCaptured()
    expect(turns()).toHaveLength(1)
    expect(row('pending-msg').querySelector('.log-turn__who')?.textContent).toBe('Peer Agent')
    expect(row('pending-msg').getAttribute('data-status')).not.toBe('failed')
    expect(host.textContent).not.toContain('Failed')
    expect(host.textContent).toContain('Unverified')
  })
  it('timeline capability unavailable 时已接受原生记录仍可读，Terminal 能力保留', async () => {
    await mount([user('rec-1', 'native message 1'), user('rec-2', 'native message 2')], [], {
      capability: 'unavailable',
    })
    expect(turns()).toHaveLength(2)
    expect(host.textContent).toContain('Terminal remains available')
  })
  it('原生输入与 assistant 共享 Participants 轴，点击原身份定位准确行', async () => {
    await mount([user('prompt-1', 'native user prompt', 100), answer('assistant-reply', 'assistant row', 200)])
    expect(turns()).toHaveLength(2)
    const marks = [...host.querySelectorAll<HTMLButtonElement>('.conversation-axis__mark')]
    expect(marks.map((mark) => mark.getAttribute('aria-label'))).toEqual(['You', 'Recipient'])
    vi.mocked(Element.prototype.scrollIntoView).mockClear()
    await act(async () => marks.find((mark) => mark.getAttribute('aria-label') === 'Recipient')!.click())
    await expectScrolledTo('assistant-reply')
    expect(
      vi
        .mocked(Element.prototype.scrollIntoView)
        .mock.contexts.some((node) => node instanceof Element && row('prompt-1').contains(node)),
    ).toBe(false)
  })
  it('统一 Participants 轴仍区分 trusted peer 与 recipient，不把 peer 变成人类', async () => {
    await mount(
      [answer('assistant-reply', 'recipient says', 200)],
      [captured('peer-input', 'user_message', 'peer says', 100, 'peer')],
    )
    await exposeCaptured()
    const marks = [
      ...host.querySelectorAll<HTMLButtonElement>(
        '.conversation-axis[aria-label="Participants"] .conversation-axis__mark',
      ),
    ]
    expect(marks.map((mark) => mark.getAttribute('aria-label'))).toEqual(['Peer Agent', 'Recipient'])
    expect(host.querySelectorAll('.conversation-avatar--human')).toHaveLength(0)
    expect(marks[0]!.querySelector('.conversation-avatar--agent')).not.toBeNull()
  })
  it('未知时间原生输入不借用另一原记录时间，保持序数定位', async () => {
    await mount(
      [user('timeless', 'timeless input')],
      [captured('assistant-dated', 'assistant_message', 'dated answer', fixtureTime(23764202000))],
    )
    await exposeCaptured()
    expect(turns()).toHaveLength(2)
    expect(row('timeless').querySelector('.log-turn__time')).toBeNull()
    expect(row('assistant-dated').querySelector('.log-turn__time')).not.toBeNull()
    expect(currentTrack().dataset.axis).toBe('ordinal')
  })
  it('混合时间不借钟点：已知时刻保 temporal，Untimed 原菜单独立定位未记录时间的原输入', async () => {
    await mount(
      [user('unknown-one', 'timeless one'), user('unknown-two', 'timeless two')],
      [
        captured('known-one', 'assistant_message', 'known-one', 1000),
        captured('known-two', 'assistant_message', 'known-two', 2000),
      ],
    )
    await exposeCaptured()
    expect(turns()).toHaveLength(4)
    expect(currentTrack().dataset.axis).toBe('temporal')
    expect(currentTrack().getAttribute('aria-valuemax')).toBe('2')
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="2 records without recorded time"]')!
    expect(trigger).not.toBeNull()
    await act(async () => {
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    })
    await wait(() => expect(document.querySelectorAll('.conversation-axis__entry')).toHaveLength(2))
    const entries = [...document.querySelectorAll<HTMLElement>('.conversation-axis__entry')]
    expect(entries.map((entry) => entry.querySelector('.conversation-axis__entry-quote')?.textContent)).toEqual([
      'timeless one',
      'timeless two',
    ])
    vi.mocked(Element.prototype.scrollIntoView).mockClear()
    await act(async () => entries[1]!.click())
    await expectScrolledTo('unknown-two')
    expect(row('unknown-one').querySelector('.log-turn__time')).toBeNull()
    expect(row('unknown-two').querySelector('.log-turn__time')).toBeNull()
    expect(row('known-one').querySelector('.log-turn__time')).not.toBeNull()
    expect(row('known-two').querySelector('.log-turn__time')).not.toBeNull()
  })
  it('全未知时间保 ordinal 原序、四枚单调 ticks 与实际 click/keyboard 定位', async () => {
    await mount(['one', 'two', 'three', 'four'].map((id) => user(id, 'timeless ' + id)))
    const track = currentTrack()
    expect(track.dataset.axis).toBe('ordinal')
    expect(track.getAttribute('aria-label')).toBe('Activity timeline, 4 events in order')
    expect(host.querySelector('.activity-ruler__span')?.textContent).toBe('Record order')
    const fractions = [...host.querySelectorAll<HTMLElement>('.activity-ruler__tick')].map((tick) =>
      parseFloat(tick.style.left),
    )
    expect(fractions).toHaveLength(4)
    fractions.forEach((fraction, index) => expect(fraction).toBeCloseTo((index * 100) / 3, 5))
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 300, 16))
    vi.spyOn(host.querySelector('.activity-feed')!, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(80, 70, 400, 500),
    )
    vi.mocked(Element.prototype.scrollIntoView).mockClear()
    await act(async () => track.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 300 })))
    await expectScrolledTo('three')
    await act(async () => track.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Home' })))
    expect(track.getAttribute('aria-valuenow')).toBe('1')
    await act(async () => track.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })))
    expect(track.getAttribute('aria-valuenow')).toBe('2')
    await act(async () => track.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 100 })))
    expect(host.querySelector('.activity-ruler__readout')?.textContent).toBe('Event 1 of 4')
    expect(host.querySelectorAll('.activity-ruler__readout-time')).toHaveLength(0)
    expect(turns().every((turn) => !turn.querySelector('.log-turn__time'))).toBe(true)
  })
  it('全量已知时间保持 temporal 标尺跨度与钟点', async () => {
    await mount(
      [],
      [
        captured('assistant-1', 'assistant_message', 'one', 1000),
        captured('assistant-2', 'assistant_message', 'two', 2000),
      ],
    )
    expect(currentTrack().dataset.axis).toBe('temporal')
    expect(currentTrack().getAttribute('aria-label')).toBe('Activity timeline, 2 events over 1.0s')
    expect(host.querySelector('.activity-ruler__span')?.getAttribute('title')).toContain('1.0s elapsed')
  })
  it('已知时间倒退保持 durable 原序而所有 temporal ticks 仍在 0..100', async () => {
    await mount(
      [],
      [
        captured('first', 'assistant_message', 'first', 1000),
        captured('middle', 'assistant_message', 'middle', 3000),
        captured('last', 'assistant_message', 'last', 2000),
      ],
    )
    await exposeCaptured()
    expect(turns()).toHaveLength(3)
    expect(currentTrack().dataset.axis).toBe('temporal')
    expect(currentTrack().getAttribute('aria-label')).toBe('Activity timeline, 3 events over 1.0s')
    const fractions: number[] = [],
      track = currentTrack()
    for (const key of ['Home', 'ArrowRight', 'ArrowRight']) {
      await act(async () => track.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key })))
      const tick = host.querySelector<HTMLElement>('.activity-ruler__tick[data-selected]')!
      expect(tick).not.toBeNull()
      fractions.push(parseFloat(tick.style.left))
    }
    expect(fractions).toEqual([0, 100, 100])
    fractions.forEach((fraction) => {
      expect(fraction).toBeGreaterThanOrEqual(0)
      expect(fraction).toBeLessThanOrEqual(100)
    })
  })
})
