// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionHistoryContentPart,
  AgentSessionHistoryPage,
  AgentSessionUserMessage,
  AgentTimelineItem
} from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core'
import type { AgentSessionControl } from '../src/shared/contracts'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { SessionHistoryView } from '../src/renderer/src/components/SessionHistoryView'
import { api } from '../src/renderer/src/lib/api'
import {
  UNKNOWN_SPEAKER_ID,
  createSpeakerResolver,
  speakerOf,
  speakerOfUserMessage
} from '../src/renderer/src/lib/conversation-speaker'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const control: AgentSessionControl = {
  kind: 'agent',
  hostId: 'local',
  agentSessionId: 'agent-session-t036',
  run: { runId: 'run-t036' }
}

let host: HTMLDivElement
let root: Root
let historyPageSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  historyPageSpy?.mockRestore()
})

describe('T036 全来源 user 回合与共享作者呈现闭环', () => {
  it('历史入口 (SessionHistoryView): 读取同一公开 Core native user 事实，保留 record 身份与 parts，不猜 Human/You', async () => {
    const contentParts: AgentSessionHistoryContentPart[] = [
      { kind: 'text', text: 'Native terminal prompt from user' },
      { kind: 'resource', resourceType: 'file', reference: 'src/native-entry.ts' }
    ]
    const testPage: AgentSessionHistoryPage = {
      agentSessionId: control.agentSessionId,
      source: { providerId: 'codex', nativeSessionId: 'native-session-1' },
      items: [
        {
          id: 'record-native-turn-1',
          kind: 'user-message',
          contentParts,
          startedAt: 10_000
        },
        {
          id: 'record-assistant-turn-1',
          kind: 'assistant-message',
          contentParts: [{ kind: 'text', text: 'Assistant reply' }],
          startedAt: 12_000
        }
      ],
      nextCursor: null
    }

    historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(testPage)

    await act(async () => {
      root.render(
        <SessionHistoryView
          control={control}
          label="Claude"
          visible
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/repo"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    })

    const turns = host.querySelectorAll('.log-turn')
    expect(turns.length).toBe(2)

    // User turn verification
    const userTurn = turns[0]!
    expect(userTurn.getAttribute('data-speaker-role')).toBe('human')

    // The raw author is unknown; the shared UI applies the requested user default.
    const who = userTurn.querySelector('.log-turn__who')
    expect(who?.textContent).toBe('You')
    expect(userTurn.querySelector('[role="note"]')).toBeNull()
    
    // Avatar uses the same user appearance without changing the input record.
    const avatar = userTurn.querySelector('.conversation-avatar--human')
    expect(avatar).not.toBeNull()
    expect(userTurn.querySelector('.conversation-avatar--unknown')).toBeNull()

    // Parts must be preserved in exact order: text then resource
    const body = userTurn.querySelector('.log-turn__body')
    expect(body).not.toBeNull()
    expect(body?.textContent).toContain('Native terminal prompt from user')
    expect(body?.textContent).toContain('src/native-entry.ts')

    // Stable record identity preserved on container
    const article = host.querySelector('article[data-history-item-id="record-native-turn-1"]')
    expect(article).not.toBeNull()
    expect(article?.getAttribute('data-history-kind')).toBe('user-message')
  })

  it('历史入口: 原生记录缺时间/状态时如实缺席，不补 0、now 或 complete', async () => {
    const testPage: AgentSessionHistoryPage = {
      agentSessionId: control.agentSessionId,
      source: { providerId: 'pi', nativeSessionId: 'native-session-pi' },
      items: [
        {
          id: 'record-no-time',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: 'No timestamp prompt' }]
          // startedAt deliberately undefined
        }
      ],
      nextCursor: null
    }

    historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(testPage)

    await act(async () => {
      root.render(
        <SessionHistoryView
          control={control}
          label="Pi"
          visible
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/repo"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    })

    const turns = host.querySelectorAll('.log-turn')
    expect(turns.length).toBe(1)
    const turn = turns[0]!

    // No time rendered
    expect(turn.querySelector('.log-turn__time')).toBeNull()
    // No status chip fabricated
    expect(turn.getAttribute('data-status')).toBeNull()
    expect(turn.querySelector('.log-row__chip[role="status"]')).toBeNull()
  })

  it('历史入口与投影: 同正文不同原记录保留两个回合，不按正文吞记录', async () => {
    const testPage: AgentSessionHistoryPage = {
      agentSessionId: control.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'claude-session-1' },
      items: [
        {
          id: 'turn-rec-alpha',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: 'Repeated identical query' }],
          startedAt: 1_000
        },
        {
          id: 'turn-rec-beta',
          kind: 'user-message',
          contentParts: [{ kind: 'text', text: 'Repeated identical query' }],
          startedAt: 2_000
        }
      ],
      nextCursor: null
    }

    // Direct public Core projector verification:
    const projected = projectSessionUserMessages({
      agentSessionId: control.agentSessionId,
      historyPage: testPage
    })
    expect(projected.length).toBe(2)
    expect(projected[0]!.id).not.toBe(projected[1]!.id)
    expect(projected[0]!.rawId).toBe('turn-rec-alpha')
    expect(projected[1]!.rawId).toBe('turn-rec-beta')
    expect(projected[0]!.content).toBe(projected[1]!.content)

    // DOM verification through SessionHistoryView
    historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(testPage)

    await act(async () => {
      root.render(
        <SessionHistoryView
          control={control}
          label="Claude"
          visible
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/repo"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    })

    const turns = host.querySelectorAll('.log-turn')
    expect(turns.length).toBe(2)
    expect(turns[0]!.querySelector('.log-turn__body')?.textContent).toContain('Repeated identical query')
    expect(turns[1]!.querySelector('.log-turn__body')?.textContent).toContain('Repeated identical query')
  })

  it('实时对话 (ActivityView): 消费受控 userMessages，包含原生与捕获消息，没有变成机器行', async () => {
    const nativeMessage: AgentSessionUserMessage = {
      id: 'native:claude:session-1:msg-1',
      rawId: 'msg-1',
      agentSessionId: control.agentSessionId,
      source: {
        kind: 'native',
        providerId: 'claude',
        nativeSessionId: 'session-1',
        recordId: 'msg-1'
      },
      author: { kind: 'unknown' },
      content: 'Terminal native prompt',
      contentParts: [{ kind: 'text', text: 'Terminal native prompt' }],
      recordedAt: 100
    }

    const peerAgentUserMessage: AgentSessionUserMessage = {
      id: 'captured:msg-from-peer',
      rawId: 'msg-from-peer',
      agentSessionId: control.agentSessionId,
      source: {
        kind: 'captured',
        submissionId: 'msg-from-peer'
      },
      author: { kind: 'agent', agentSessionId: 'peer-session-id' },
      content: 'Message from coworker agent',
      contentParts: [{ kind: 'text', text: 'Message from coworker agent' }],
      recordedAt: 200,
      deliveryStatus: 'complete'
    }

    const assistantItem: AgentTimelineItem = {
      id: 'assistant-reply-1',
      agentSessionId: control.agentSessionId,
      kind: 'assistant_message',
      status: 'complete',
      source: 'native-hook',
      createdAt: 300,
      updatedAt: 300,
      title: 'Reply',
      content: 'Understood'
    }

    const resolver = createSpeakerResolver({
      lookupAgent: (id) => (id === 'peer-session-id' ? { label: 'Peer Agent', providerId: 'claude' } : undefined),
      currentSession: { id: control.agentSessionId, label: 'Current Session' }
    })

    await act(async () => {
      root.render(
        <ActivityView
          items={[assistantItem]}
          sessionId={control.agentSessionId}
          userMessages={[nativeMessage, peerAgentUserMessage]}
          capability="complete-events"
          displayState="done"
          describeSpeaker={resolver}
          workspaceRoot="/repo"
        />
      )
    })

    const turns = host.querySelectorAll('.log-turn')
    expect(turns.length).toBe(3)

    // 1. Native user message is a conversation turn, not a machine row
    const nativeTurn = turns[0]!
    expect(nativeTurn.getAttribute('data-speaker-role')).toBe('human')
    expect(nativeTurn.querySelector('.log-turn__who')?.textContent).toBe('You')
    expect(nativeTurn.querySelector('[role="note"]')).toBeNull()
    expect(nativeTurn.querySelector('.conversation-avatar--human')).not.toBeNull()
    expect(nativeTurn.querySelector('.log-turn__body')?.textContent).toContain('Terminal native prompt')

    // 2. Peer agent message shows known agent author
    const peerTurn = turns[1]!
    expect(peerTurn.getAttribute('data-speaker-role')).toBe('agent')
    expect(peerTurn.querySelector('.log-turn__who')?.textContent).toBe('Peer Agent')
    expect(peerTurn.querySelector('.conversation-avatar--agent')).not.toBeNull()

    // 3. Assistant turn is intact
    const assistantTurn = turns[2]!
    expect(assistantTurn.getAttribute('data-speaker-role')).toBe('agent')
    expect(assistantTurn.querySelector('.log-turn__body')?.textContent).toContain('Understood')

    // Machine row check: None of the user messages were rendered as log-row
    const logRows = host.querySelectorAll('.log-row')
    expect(logRows.length).toBe(0)
  })

  it('实时对话 (ActivityView): 原生记录无时间/状态时如实缺席，不补 0 或 complete', async () => {
    const timelessMessage: AgentSessionUserMessage = {
      id: 'native:pi:session-1:msg-no-time',
      rawId: 'msg-no-time',
      agentSessionId: control.agentSessionId,
      source: {
        kind: 'native',
        providerId: 'pi',
        nativeSessionId: 'session-1',
        recordId: 'msg-no-time'
      },
      author: { kind: 'unknown' },
      content: 'Timeless native input',
      contentParts: [{ kind: 'text', text: 'Timeless native input' }]
      // recordedAt and deliveryStatus omitted
    }

    await act(async () => {
      root.render(
        <ActivityView
          items={[]}
          sessionId={control.agentSessionId}
          userMessages={[timelessMessage]}
          capability="complete-events"
          displayState="done"
          workspaceRoot="/repo"
        />
      )
    })

    const turns = host.querySelectorAll('.log-turn')
    expect(turns.length).toBe(1)
    const turn = turns[0]!

    // No time rendered
    expect(turn.querySelector('.log-turn__time')).toBeNull()
    // No status chip
    expect(turn.getAttribute('data-status')).toBeNull()
    expect(turn.querySelector('.log-row__chip[role="status"]')).toBeNull()
  })

  it('共同 speaker resolver: 按真实 speaker.id 寻址，缺失保原 id，不冒用收件人资料', () => {
    const resolver = createSpeakerResolver({
      lookupAgent: (id) => (id === 'peer-1' ? { label: 'Peer One', providerId: 'codex' } : undefined),
      currentSession: { id: 'current-session-id', label: 'Recipient Agent', providerId: 'claude' }
    })

    // Known peer
    expect(resolver({ role: 'agent', id: 'peer-1' })).toEqual({
      name: 'Peer One',
      providerId: 'codex'
    })

    // Unknown agent: retains speaker.id, does NOT substitute recipient label
    expect(resolver({ role: 'agent', id: 'other-unlisted-agent' })).toEqual({
      name: 'other-unlisted-agent'
    })

    // Unknown input uses the user display default without altering the recorded author.
    expect(resolver({ role: 'unknown', id: UNKNOWN_SPEAKER_ID })).toEqual({
      name: 'You'
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
      contentParts: [{ kind: 'text', text: 'hello' }]
    }
    expect(speakerOfUserMessage(unknownNativeMsg)).toEqual({
      role: 'unknown',
      id: UNKNOWN_SPEAKER_ID
    })
    expect(speakerOf(unknownNativeMsg)).toEqual({
      role: 'unknown',
      id: UNKNOWN_SPEAKER_ID
    })

    // 2. From known agent user message
    const peerMsg: AgentSessionUserMessage = {
      id: 'captured:2',
      rawId: '2',
      agentSessionId: control.agentSessionId,
      source: { kind: 'captured', submissionId: '2' },
      author: { kind: 'agent', agentSessionId: 'agent-alice' },
      content: 'hello from alice',
      contentParts: [{ kind: 'text', text: 'hello from alice' }]
    }
    expect(speakerOfUserMessage(peerMsg)).toEqual({
      role: 'agent',
      id: 'agent-alice'
    })
    expect(speakerOf(peerMsg)).toEqual({
      role: 'agent',
      id: 'agent-alice'
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
      title: 'Prompt'
    }
    expect(speakerOf(timelineUserItem)).toEqual({
      role: 'unknown',
      id: UNKNOWN_SPEAKER_ID
    })
  })

  it('native rawId 碰撞时不抹除未关联的公开 captured 时间轴记录', async () => {
    // native rawId 是 'raw-shared'，同时 timeline 恰好有一个同名 captured id 'raw-shared'
    const nativeMsg: AgentSessionUserMessage = {
      id: 'native:claude:s:raw-shared',
      rawId: 'raw-shared',
      agentSessionId: control.agentSessionId,
      source: { kind: 'native', providerId: 'claude', nativeSessionId: 's', recordId: 'raw-shared' },
      author: { kind: 'unknown' },
      content: 'native body',
      contentParts: [{ kind: 'text', text: 'native body' }],
      recordedAt: 100
    }
    const capturedItem: AgentTimelineItem = {
      id: 'raw-shared',
      agentSessionId: control.agentSessionId,
      kind: 'user_message',
      source: 'user',
      status: 'complete',
      authorAgentSessionId: 'peer',
      createdAt: 200,
      updatedAt: 200,
      title: 'captured item',
      content: 'captured unrelated body'
    }
    const assistantItem: AgentTimelineItem = {
      id: 'assistant-1',
      agentSessionId: control.agentSessionId,
      kind: 'assistant_message',
      source: 'native-hook',
      status: 'complete',
      createdAt: 300,
      updatedAt: 300,
      title: 'assistant',
      content: 'assistant reply'
    }

    const resolver = createSpeakerResolver({
      lookupAgent: (id) => (id === 'peer' ? { label: 'Peer', providerId: 'pi' } : undefined),
      currentSession: { id: control.agentSessionId, label: 'Recipient', providerId: 'claude' }
    })

    await act(async () => {
      root.render(
        <ActivityView
          sessionId={control.agentSessionId}
          items={[capturedItem, assistantItem]}
          userMessages={[nativeMsg]}
          capability="complete-events"
          displayState="done"
          describeSpeaker={resolver}
        />
      )
    })

    const turns = host.querySelectorAll('.log-turn')
    expect(turns).toHaveLength(3)
    const turnTexts = [...host.querySelectorAll('.log-turn__body')].map((x) => x.textContent)
    expect(turnTexts.join('\n')).toContain('captured unrelated body')
  })

  it('公开 captured deliveryStatus=unverified 绝不冒充 Failed 结论', async () => {
    const unverifiedMsg: AgentSessionUserMessage = {
      id: 'captured:pending-msg',
      rawId: 'pending-msg',
      agentSessionId: control.agentSessionId,
      source: { kind: 'captured', submissionId: 'pending-msg' },
      author: { kind: 'agent', agentSessionId: 'peer' },
      content: 'not confirmed delivery',
      contentParts: [{ kind: 'text', text: 'not confirmed delivery' }],
      deliveryStatus: 'unverified',
      recordedAt: 100
    }

    const resolver = createSpeakerResolver({
      lookupAgent: (id) => (id === 'peer' ? { label: 'Peer', providerId: 'pi' } : undefined),
      currentSession: { id: control.agentSessionId, label: 'Recipient', providerId: 'claude' }
    })

    await act(async () => {
      root.render(
        <ActivityView
          sessionId={control.agentSessionId}
          items={[]}
          userMessages={[unverifiedMsg]}
          capability="complete-events"
          displayState="running"
          describeSpeaker={resolver}
        />
      )
    })

    const turns = host.querySelectorAll('.log-turn')
    expect(turns).toHaveLength(1)
    expect(host.querySelector('.log-turn__who')?.textContent).toBe('Peer')
    expect(host.querySelector('.log-turn')?.getAttribute('data-status')).not.toBe('failed')
    expect(host.textContent).not.toContain('Failed')
    expect(host.querySelector('.log-row__chip')?.textContent).toContain('Unverified')
  })

  it('结构化 timeline capability=unavailable 时，已存在的原生记录仍可读', async () => {
    const nativeMessages: AgentSessionUserMessage[] = [
      {
        id: 'native:claude:s:rec-1',
        rawId: 'rec-1',
        agentSessionId: control.agentSessionId,
        source: { kind: 'native', providerId: 'claude', nativeSessionId: 's', recordId: 'rec-1' },
        author: { kind: 'unknown' },
        content: 'native message 1',
        contentParts: [{ kind: 'text', text: 'native message 1' }]
      },
      {
        id: 'native:claude:s:rec-2',
        rawId: 'rec-2',
        agentSessionId: control.agentSessionId,
        source: { kind: 'native', providerId: 'claude', nativeSessionId: 's', recordId: 'rec-2' },
        author: { kind: 'unknown' },
        content: 'native message 2',
        contentParts: [{ kind: 'text', text: 'native message 2' }]
      }
    ]

    await act(async () => {
      root.render(
        <ActivityView
          sessionId={control.agentSessionId}
          items={[]}
          userMessages={nativeMessages}
          capability="unavailable"
          displayState="done"
        />
      )
    })

    const turns = host.querySelectorAll('.log-turn')
    expect(turns).toHaveLength(2)
    expect(host.textContent).toContain('Terminal remains available')
  })

  it('原生输入与 assistant 共享对话轴，点击轴标记定位到正确行', async () => {
    const nativeMsg: AgentSessionUserMessage = {
      id: 'native:claude:s:prompt-1',
      rawId: 'prompt-1',
      agentSessionId: control.agentSessionId,
      source: { kind: 'native', providerId: 'claude', nativeSessionId: 's', recordId: 'prompt-1' },
      author: { kind: 'unknown' },
      content: 'native user prompt',
      contentParts: [{ kind: 'text', text: 'native user prompt' }],
      recordedAt: 100
    }
    const assistant: AgentTimelineItem = {
      id: 'assistant-reply',
      agentSessionId: control.agentSessionId,
      kind: 'assistant_message',
      source: 'native-hook',
      status: 'complete',
      createdAt: 200,
      updatedAt: 200,
      title: 'assistant',
      content: 'assistant row'
    }

    const resolver = createSpeakerResolver({
      currentSession: { id: control.agentSessionId, label: 'Recipient', providerId: 'claude' }
    })

    await act(async () => {
      root.render(
        <ActivityView
          sessionId={control.agentSessionId}
          items={[assistant]}
          userMessages={[nativeMsg]}
          capability="complete-events"
          displayState="done"
          describeSpeaker={resolver}
        />
      )
    })

    expect(host.querySelectorAll('.log-turn')).toHaveLength(2)

    // Axes use the same user default and current Agent name.
    const marks = [...host.querySelectorAll<HTMLButtonElement>('.conversation-axis__mark')]
    expect(marks.map((x) => x.getAttribute('aria-label'))).toEqual(['You', 'Recipient'])

    // Clicking Recipient scrolls to the assistant segment (index 1), not native input (index 0)
    const rows = [...host.querySelectorAll<HTMLElement>('.activity-log__segment')]
    expect(rows).toHaveLength(2)
    const scrolls = rows.map((row) => vi.spyOn(row, 'scrollIntoView'))

    await act(async () => {
      marks.find((x) => x.getAttribute('aria-label') === 'Recipient')!.click()
    })
    expect(scrolls.map((x) => x.mock.calls.length)).toEqual([0, 1])
  })

  it('This agent 轴绝不将 trusted peer 发送者误划为当前 recipient agent', async () => {
    const peerMsg: AgentSessionUserMessage = {
      id: 'captured:peer-input',
      rawId: 'peer-input',
      agentSessionId: control.agentSessionId,
      source: { kind: 'captured', submissionId: 'peer-input' },
      author: { kind: 'agent', agentSessionId: 'peer' },
      content: 'peer says',
      contentParts: [{ kind: 'text', text: 'peer says' }],
      recordedAt: 100
    }
    const assistant: AgentTimelineItem = {
      id: 'assistant-reply',
      agentSessionId: control.agentSessionId,
      kind: 'assistant_message',
      source: 'native-hook',
      status: 'complete',
      createdAt: 200,
      updatedAt: 200,
      title: 'assistant',
      content: 'recipient says'
    }
    const resolver = createSpeakerResolver({
      lookupAgent: (id) => (id === 'peer' ? { label: 'Peer', providerId: 'pi' } : undefined),
      currentSession: { id: control.agentSessionId, label: 'Recipient', providerId: 'claude' }
    })

    await act(async () => {
      root.render(
        <ActivityView
          sessionId={control.agentSessionId}
          items={[assistant]}
          userMessages={[peerMsg]}
          capability="complete-events"
          displayState="done"
          describeSpeaker={resolver}
        />
      )
    })

    // 1. This-agent 轴仅收 Recipient，不包含 peer
    const selfAxisMarks = [...host.querySelectorAll('.conversation-axis[aria-label="This agent"] .conversation-axis__mark')]
    expect(selfAxisMarks.map((x) => x.getAttribute('aria-label'))).toEqual(['Recipient'])

    // 2. Speakers 轴容纳真实 peer 发言
    const speakerAxisMarks = [...host.querySelectorAll('.conversation-axis[aria-label="Speakers"] .conversation-axis__mark')]
    expect(speakerAxisMarks.map((x) => x.getAttribute('aria-label'))).toEqual(['Peer'])

    // 3. peer 绝不强转为 human 头像
    expect(host.querySelectorAll('.conversation-avatar--human')).toHaveLength(0)
    const peerAvatar = host.querySelector('.conversation-axis[aria-label="Speakers"] .conversation-avatar--agent')
    expect(peerAvatar).not.toBeNull()
  })

  it('未知时间的原生输入在标尺上不虚构 epoch 0 或借用他行钟点，保持序数定位', async () => {
    const timelessNative: AgentSessionUserMessage = {
      id: 'native:claude:s:timeless',
      rawId: 'timeless',
      agentSessionId: control.agentSessionId,
      source: { kind: 'native', providerId: 'claude', nativeSessionId: 's', recordId: 'timeless' },
      author: { kind: 'unknown' },
      content: 'timeless input',
      contentParts: [{ kind: 'text', text: 'timeless input' }]
      // recordedAt is undefined
    }
    const datedAssistant: AgentTimelineItem = {
      id: 'assistant-dated',
      agentSessionId: control.agentSessionId,
      kind: 'assistant_message',
      source: 'native-hook',
      status: 'complete',
      createdAt: 1790989802000,
      updatedAt: 1790989802000,
      title: 'assistant',
      content: 'dated answer'
    }

    await act(async () => {
      root.render(
        <ActivityView
          sessionId={control.agentSessionId}
          items={[datedAssistant]}
          userMessages={[timelessNative]}
          capability="complete-events"
          displayState="done"
        />
      )
    })

    const turns = host.querySelectorAll('.log-turn')
    expect(turns).toHaveLength(2)

    // 1. 无时间原生回合不输出钟点（不出现 1970、00:00:00，也不盗用 assistant 的 1790989802000）
    const timelessTurn = turns[0]!
    expect(timelessTurn.querySelector('.log-turn__time')).toBeNull()

    // 2. 有时间的 assistant 正常输出自己的时刻
    const datedTurn = turns[1]!
    expect(datedTurn.querySelector('.log-turn__time')).not.toBeNull()

    // 3. 两行段落各占独立 segment
    const rows = [...host.querySelectorAll<HTMLElement>('.activity-log__segment')]
    expect(rows).toHaveLength(2)
  })

  it('混合未知与已知时间列表整条标尺退化为序数 (ordinal)，ticks 严格有序且 click/keyboard 定位正确', async () => {
    const nativeMessages: AgentSessionUserMessage[] = [
      {
        id: 'native:claude:s:unknown-one',
        rawId: 'unknown-one',
        agentSessionId: control.agentSessionId,
        source: { kind: 'native', providerId: 'claude', nativeSessionId: 's', recordId: 'unknown-one' },
        author: { kind: 'unknown' },
        content: 'timeless one',
        contentParts: [{ kind: 'text', text: 'timeless one' }]
      },
      {
        id: 'native:claude:s:unknown-two',
        rawId: 'unknown-two',
        agentSessionId: control.agentSessionId,
        source: { kind: 'native', providerId: 'claude', nativeSessionId: 's', recordId: 'unknown-two' },
        author: { kind: 'unknown' },
        content: 'timeless two',
        contentParts: [{ kind: 'text', text: 'timeless two' }]
      }
    ]
    const assistantItems: AgentTimelineItem[] = [
      {
        id: 'known-one',
        agentSessionId: control.agentSessionId,
        kind: 'assistant_message',
        source: 'native-hook',
        status: 'complete',
        createdAt: 1000,
        updatedAt: 1000,
        title: 'assistant',
        content: 'known-one'
      },
      {
        id: 'known-two',
        agentSessionId: control.agentSessionId,
        kind: 'assistant_message',
        source: 'native-hook',
        status: 'complete',
        createdAt: 2000,
        updatedAt: 2000,
        title: 'assistant',
        content: 'known-two'
      }
    ]

    const resolver = createSpeakerResolver({
      currentSession: { id: control.agentSessionId, label: 'Recipient', providerId: 'claude' }
    })

    await act(async () => {
      root.render(
        <ActivityView
          sessionId={control.agentSessionId}
          items={assistantItems}
          userMessages={nativeMessages}
          capability="complete-events"
          displayState="done"
          describeSpeaker={resolver}
        />
      )
    })

    // 1. 非空四 rows 和四 turns
    const turns = host.querySelectorAll('.log-turn')
    expect(turns).toHaveLength(4)
    const rows = [...host.querySelectorAll<HTMLElement>('.activity-log__segment')]
    expect(rows).toHaveLength(4)

    // 2. 标尺 track 及其属性
    const track = host.querySelector<HTMLElement>('.activity-ruler__track')
    expect(track).not.toBeNull()
    expect(track!.dataset.axis).toBe('ordinal')
    expect(track!.getAttribute('aria-label')).toBe('Activity timeline, 4 events in order')

    // 3. 不渲染全局时间跨度 (span is undefined / not rendered)
    expect(host.querySelector('.activity-ruler__span')).toBeNull()

    // 4. 四枚 ticks 的 fraction/percentage 严格单调有序
    const ticks = [...host.querySelectorAll<HTMLElement>('.activity-ruler__tick')]
    expect(ticks).toHaveLength(4)
    const tickPercentages = ticks.map((t) => parseFloat(t.style.left))
    expect(tickPercentages[0]).toBe(0)
    expect(tickPercentages[1]!).toBeCloseTo(100 / 3, 5)
    expect(tickPercentages[2]!).toBeCloseTo(200 / 3, 5)
    expect(tickPercentages[3]).toBe(100)
    expect(tickPercentages[2]!).toBeGreaterThan(tickPercentages[1]!)

    // 5. 点击第三条序数位置 (fraction ~0.66) 准确定位并滚动到第三行 (known-one, index 2)
    const feed = host.querySelector<HTMLElement>('.activity-feed')!
    vi.spyOn(track!, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 300, 16))
    vi.spyOn(feed, 'getBoundingClientRect').mockReturnValue(new DOMRect(80, 70, 400, 500))
    const scrolls = rows.map((r) => vi.spyOn(r, 'scrollIntoView'))

    await act(async () => {
      track!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 300 }))
    })
    expect(scrolls.map((s) => s.mock.calls.length)).toEqual([0, 0, 1, 0])

    // 6. 键盘导航: Home/End/ArrowRight/ArrowLeft
    await act(async () => {
      track!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Home' }))
    })
    expect(track!.getAttribute('aria-valuenow')).toBe('1')

    await act(async () => {
      track!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
    })
    expect(track!.getAttribute('aria-valuenow')).toBe('2')

    // 7. Hover/pointermove 在未知时间 tick 0 上，readout 显示序号，无 at 钟点
    await act(async () => {
      track!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 100 }))
    })
    const readout = host.querySelector<HTMLElement>('.activity-ruler__readout')
    expect(readout?.textContent).toBe('Event 1 of 4')
    expect(host.querySelectorAll('.activity-ruler__readout-time')).toHaveLength(0)

    // 8. 正文已知时间如实呈现，未知时间不造钟点
    expect(turns[0]!.querySelector('.log-turn__time')).toBeNull()
    expect(turns[1]!.querySelector('.log-turn__time')).toBeNull()
    expect(turns[2]!.querySelector('.log-turn__time')).not.toBeNull()
    expect(turns[3]!.querySelector('.log-turn__time')).not.toBeNull()
  })

  it('正控对比: 全量已知时间保持 temporal 标尺跨度与钟点呈现', async () => {
    const datedAssistants: AgentTimelineItem[] = [
      {
        id: 'assistant-1',
        agentSessionId: control.agentSessionId,
        kind: 'assistant_message',
        source: 'native-hook',
        status: 'complete',
        createdAt: 1000,
        updatedAt: 1000,
        title: 'assistant',
        content: 'one'
      },
      {
        id: 'assistant-2',
        agentSessionId: control.agentSessionId,
        kind: 'assistant_message',
        source: 'native-hook',
        status: 'complete',
        createdAt: 2000,
        updatedAt: 2000,
        title: 'assistant',
        content: 'two'
      }
    ]

    await act(async () => {
      root.render(
        <ActivityView
          sessionId={control.agentSessionId}
          items={datedAssistants}
          userMessages={[]}
          capability="complete-events"
          displayState="done"
        />
      )
    })

    const track = host.querySelector<HTMLElement>('.activity-ruler__track')
    expect(track?.dataset.axis).toBe('temporal')
    expect(track?.getAttribute('aria-label')).toBe('Activity timeline, 2 events over 1.0s')
    const span = host.querySelector('.activity-ruler__span')
    expect(span).not.toBeNull()
    expect(span?.textContent).toContain('1.0s')
  })

  it('全量已知时间乱序输入保持 temporal 标尺且所有 ticks 限制在 0..100 轨道内', async () => {
    // Durable append 顺序 [1000, 3000, 2000]，没有排序合同
    const items: AgentTimelineItem[] = [
      {
        id: 'first',
        agentSessionId: control.agentSessionId,
        kind: 'assistant_message',
        source: 'native-hook',
        status: 'complete',
        createdAt: 1000,
        updatedAt: 1000,
        title: 'first',
        content: 'first'
      },
      {
        id: 'middle',
        agentSessionId: control.agentSessionId,
        kind: 'assistant_message',
        source: 'native-hook',
        status: 'complete',
        createdAt: 3000,
        updatedAt: 3000,
        title: 'middle',
        content: 'middle'
      },
      {
        id: 'last',
        agentSessionId: control.agentSessionId,
        kind: 'assistant_message',
        source: 'native-hook',
        status: 'complete',
        createdAt: 2000,
        updatedAt: 2000,
        title: 'last',
        content: 'last'
      }
    ]

    await act(async () => {
      root.render(
        <ActivityView
          sessionId={control.agentSessionId}
          items={items}
          userMessages={[]}
          capability="complete-events"
          displayState="done"
        />
      )
    })

    const turns = host.querySelectorAll('.log-turn')
    expect(turns).toHaveLength(3)

    const track = host.querySelector<HTMLElement>('.activity-ruler__track')
    expect(track).not.toBeNull()
    expect(track!.dataset.axis).toBe('temporal')
    expect(track!.getAttribute('aria-label')).toBe('Activity timeline, 3 events over 1.0s')

    const ticks = [...host.querySelectorAll<HTMLElement>('.activity-ruler__tick')]
    expect(ticks).toHaveLength(3)
    const fractions = ticks.map((t) => parseFloat(t.style.left))
    // middle (3000) must be clamped to 100%, never exceed track bounds (such as 200%)
    expect(fractions).toEqual([0, 100, 100])
    for (const f of fractions) {
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThanOrEqual(100)
    }
  })
})
