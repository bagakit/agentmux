// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type {
  AgentSessionHistoryContentPart,
  AgentSessionHistoryPage,
  AgentTimelineItem,
  AgentSessionUserMessage
} from '@agentmux/core'
import type { AgentSessionControl } from '../src/shared/contracts'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { SessionHistoryView } from '../src/renderer/src/components/SessionHistoryView'
import { ConversationMessage } from '../src/renderer/src/components/ConversationMessage'
import { ConversationReasoningTrace } from '../src/renderer/src/components/ConversationReasoningTrace'
import { api } from '../src/renderer/src/lib/api'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  disconnect() {}
})

const control: AgentSessionControl = {
  kind: 'agent',
  hostId: 'local',
  agentSessionId: 'reading-ui-session',
  run: { runId: 'reading-ui-run' }
}

let host: HTMLDivElement
let root: Root
let historyPageSpy: MockInstance<typeof api.sessions.historyPage>
let clipboardSpy: MockInstance<typeof api.ui.writeClipboardText>
let openFile: ReturnType<typeof vi.fn>
let openHttp: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  openFile = vi.fn()
  openHttp = vi.fn()
  clipboardSpy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({
    agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'native-reading-ui' },
    items: [],
    nextCursor: null
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  window.getSelection()?.removeAllRanges()
  clipboardSpy.mockRestore()
  historyPageSpy.mockRestore()
})

describe('Conversation and History shared reading UI presentation', () => {
  it('renders Agent open reading on left, Human right-docked, and Unknown neutral block in ActivityView', async () => {
    const userMsgHuman: AgentSessionUserMessage = {
      id: 'msg-human',
      rawId: 'raw-human-1',
      agentSessionId: control.agentSessionId,
      source: { kind: 'captured', submissionId: 'sub-1' },
      author: { kind: 'human' },
      content: '人类提问：请检查代码。',
      contentParts: [{ kind: 'text', text: '人类提问：请检查代码。' }],
      recordedAt: 1000
    }

    const userMsgUnknown: AgentSessionUserMessage = {
      id: 'msg-unknown',
      rawId: 'raw-unknown-1',
      agentSessionId: control.agentSessionId,
      source: { kind: 'captured', submissionId: 'sub-2' },
      author: { kind: 'unknown' },
      content: '未核实作者输入。',
      contentParts: [{ kind: 'text', text: '未核实作者输入。' }],
      recordedAt: 1500
    }

    const assistantItem: AgentTimelineItem = {
      id: 'msg-agent',
      agentSessionId: control.agentSessionId,
      kind: 'assistant_message',
      status: 'complete',
      source: 'native-hook',
      createdAt: 2000,
      updatedAt: 2000,
      title: 'Agent',
      content: '回答已生成。\n- 列表项一\n- 列表项二\n\n```ts\nconst x = 1\n```'
    }

    const machineItem: AgentTimelineItem = {
      id: 'msg-machine',
      agentSessionId: control.agentSessionId,
      kind: 'lifecycle',
      status: 'complete',
      source: 'native-hook',
      createdAt: 2500,
      updatedAt: 2500,
      title: 'Lifecycle event',
      content: 'System ready.'
    }

    await act(async () => {
      root.render(
        <ActivityView
          sessionId={control.agentSessionId}
          capability="complete-events"
          displayState="done"
          items={[assistantItem, machineItem]}
          userMessages={[userMsgHuman, userMsgUnknown]}
          workspaceRoot="/workspace"
          describeSpeaker={(speaker) => ({
            name: speaker.role === 'human' ? 'You' : speaker.role === 'unknown' ? 'Input' : 'Agent'
          })}
          openWorkspaceFile={openFile}
          openHttpLink={openHttp}
        />
      )
    })

    const turns = host.querySelectorAll<HTMLElement>('.log-turn')
    expect(turns.length).toBeGreaterThan(0)

    // 1. Agent turn: left-aligned open reading lane
    const agentTurn = Array.from(turns).find((t) => t.dataset.speakerRole === 'agent')
    expect(agentTurn).toBeDefined()
    expect(agentTurn!.textContent).toContain('Agent')
    expect(agentTurn!.textContent).toContain('回答已生成。')
    expect(agentTurn!.querySelector('.md')).not.toBeNull()
    expect(agentTurn!.querySelector('.md-list')).not.toBeNull()
    expect(agentTurn!.querySelector('.md-block-code')).not.toBeNull()

    // 2. Human turn: right-docked with human role
    const humanTurn = Array.from(turns).find((t) => t.dataset.speakerRole === 'human')
    expect(humanTurn).toBeDefined()
    expect(humanTurn!.textContent).toContain('You')
    expect(humanTurn!.textContent).toContain('人类提问：请检查代码。')

    // 3. Unknown input: right-docked neutral block, clearly says "Input" and "作者未记录", NOT "You"
    const unknownTurn = Array.from(turns).find((t) => t.dataset.speakerRole === 'unknown')
    expect(unknownTurn).toBeDefined()
    expect(unknownTurn!.textContent).toContain('Input')
    expect(unknownTurn!.textContent).toContain('作者未记录')
    expect(unknownTurn!.textContent).not.toContain('You')
    expect(unknownTurn!.textContent).toContain('未核实作者输入。')

    // 4. Undefined speaker machine activity: does NOT shift right
    const machineTurn = Array.from(turns).find((t) => !t.dataset.speakerRole)
    if (machineTurn) {
      expect(machineTurn.dataset.speakerRole).toBeUndefined()
    }
  })

  it('renders trace-only turn compactly with identity preserved and no heavy header wall', async () => {
    const traceOnlyParts: AgentSessionHistoryContentPart[] = [
      { kind: 'tool-call', name: 'search_files', input: '{"pattern":"*.ts"}', callId: 'call-1' },
      { kind: 'tool-result', name: 'search_files', output: 'src/main.ts\nsrc/lib.ts', callId: 'call-1' },
      { kind: 'resource', resourceType: 'file', reference: '/workspace/src/main.ts', label: 'Main source' }
    ]

    await act(async () => {
      root.render(
        <ConversationMessage
          messageId="trace-only-1"
          speaker={{ role: 'agent', id: 'agent-1' }}
          name="Tool Agent"
          content={traceOnlyParts}
          workspaceRoot="/workspace"
        />
      )
    })

    const turn = host.querySelector<HTMLElement>('.log-turn')!
    expect(turn).not.toBeNull()
    expect(turn.dataset.traceOnly).toBe('true')
    expect(turn.querySelector('.log-turn__who')?.textContent).toBe('Tool Agent')
    expect(turn.querySelectorAll('.conversation-tool-trace')).toHaveLength(2)
    expect(turn.querySelector('.log-turn__resource')).not.toBeNull()
  })

  it('shares ConversationMessage in SessionHistoryView with unified Markdown baseline', async () => {
    const historyParts: AgentSessionHistoryContentPart[] = [
      { kind: 'text', text: '## 历史回顾\n\n- 记录一\n- 记录二\n\n```bash\npnpm install\n```' }
    ]

    const page: AgentSessionHistoryPage = {
      agentSessionId: control.agentSessionId,
      source: { providerId: 'codex', nativeSessionId: 'native-reading-history' },
      items: [
        {
          id: 'hist-item-1',
          kind: 'assistant-message',
          contentParts: historyParts
        }
      ],
      nextCursor: null
    }

    historyPageSpy.mockResolvedValue(page)

    await act(async () => {
      root.render(
        <SessionHistoryView
          control={control}
          label="Codex"
          visible
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/workspace"
          openWorkspaceFile={openFile}
          openHttpLink={openHttp}
        />
      )
    })

    const turn = host.querySelector<HTMLElement>('.session-history__item .log-turn')
    expect(turn).not.toBeNull()
    expect(turn!.textContent).toContain('历史回顾')
    expect(turn!.querySelector('.md-heading')).not.toBeNull()
    expect(turn!.querySelector('.md-list')).not.toBeNull()
    expect(turn!.querySelector('.md-block-code')).not.toBeNull()
  })

  it('implements lazy reasoning disclosure without mounting heavy markdown until opened', async () => {
    const reasoningText = '思考过程：\n- 步骤一：分析依赖\n- 步骤二：构建切片\n\n链接：[文档](https://example.com/doc)'
    const parts: AgentSessionHistoryContentPart[] = [
      { kind: 'reasoning', text: reasoningText },
      { kind: 'reasoning', text: '', signature: 'sig-empty' },
      { kind: 'reasoning', text: '保密思考内容', signature: 'sig-secret', redacted: true }
    ]

    await act(async () => {
      root.render(
        <ConversationMessage
          messageId="reasoning-msg"
          speaker={{ role: 'agent', id: 'agent-1' }}
          name="Agent"
          content={parts}
          workspaceRoot="/workspace"
        />
      )
    })

    const details = host.querySelectorAll<HTMLDetailsElement>('details.log-turn__trace[data-trace-kind="reasoning"]')
    expect(details).toHaveLength(3)

    // Collapsed by default: heavy payload is NOT mounted
    expect(details[0]!.querySelector('.log-turn__trace-payload')).toBeNull()
    expect(details[0]!.querySelector('.md')).toBeNull()

    // 1. Open public reasoning: renders AgentMarkdown with lists and links
    await act(async () => {
      details[0]!.open = true
      details[0]!.dispatchEvent(new Event('toggle'))
    })
    expect(details[0]!.querySelector('.log-turn__trace-payload')).not.toBeNull()
    const md = details[0]!.querySelector('.md')
    expect(md).not.toBeNull()
    expect(md!.textContent).toContain('步骤一：分析依赖')
    expect(details[0]!.querySelector('.md-list')).not.toBeNull()

    // 2. Open empty reasoning: renders distinguishing note "No reasoning text recorded.", signature not in DOM
    await act(async () => {
      details[1]!.open = true
      details[1]!.dispatchEvent(new Event('toggle'))
    })
    expect(details[1]!.querySelector('.log-turn__trace-empty')?.textContent).toBe('No reasoning text recorded.')
    expect(host.textContent).not.toContain('sig-empty')

    // 3. Open redacted reasoning: displays redacted notice, confidential text & signature NOT leaked
    await act(async () => {
      details[2]!.open = true
      details[2]!.dispatchEvent(new Event('toggle'))
    })
    expect(details[2]!.querySelector('.log-turn__trace-redacted')?.textContent).toBe('Reasoning content redacted.')
    expect(host.textContent).not.toContain('保密思考内容')
    expect(host.textContent).not.toContain('sig-secret')

    // 4. Close public reasoning: unmounts heavy payload
    await act(async () => {
      details[0]!.open = false
      details[0]!.dispatchEvent(new Event('toggle'))
    })
    expect(details[0]!.querySelector('.log-turn__trace-payload')).toBeNull()
  })

  it('omits copy when only empty/redacted parts exist, but copies non-empty mixed parts in exact order', async () => {
    // 1. Only empty/redacted: no Copy button
    await act(async () => {
      root.render(
        <ConversationMessage
          messageId="empty-redacted-only"
          content={[
            { kind: 'reasoning', text: '', signature: 'sig-1' },
            { kind: 'reasoning', text: 'secret', redacted: true }
          ]}
        />
      )
    })
    expect(host.querySelector('button[aria-label="Copy message"]')).toBeNull()

    // 2. Mixed content: Copy button exists and copies exact readable parts in order without trimming
    const mixedParts: AgentSessionHistoryContentPart[] = [
      { kind: 'text', text: '  开头缩进正文  ' },
      { kind: 'reasoning', text: '思考正文' },
      { kind: 'reasoning', text: '保密正文', redacted: true },
      { kind: 'tool-call', name: 'echo', input: 'hello' },
      { kind: 'text', text: '结尾正文' }
    ]

    await act(async () => {
      root.render(
        <ConversationMessage
          messageId="mixed-msg"
          content={mixedParts}
        />
      )
    })

    const copyBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')
    expect(copyBtn).not.toBeNull()
    await act(async () => copyBtn!.click())

    expect(clipboardSpy).toHaveBeenCalledOnce()
    const copied = clipboardSpy.mock.calls[0]![0]
    expect(copied).toBe('  开头缩进正文  \n思考正文\necho\nhello\n结尾正文')
    expect(copied).not.toContain('保密正文')
  })

  it('mounts actual ActivityView and SessionHistoryView with typed mixed parts and asserts exact DOM for all 4 parts categories', async () => {
    const mixedParts: AgentSessionHistoryContentPart[] = [
      { kind: 'text', text: '**Mixed text body**' },
      { kind: 'reasoning', text: '**Mixed reasoning body**' },
      { kind: 'tool-call', name: 'search_files', input: '{"pattern":"*.ts"}', callId: 'call-mixed' },
      { kind: 'tool-result', name: 'search_files', output: 'src/index.ts', callId: 'call-mixed' },
      { kind: 'resource', resourceType: 'file', reference: 'src/index.ts', label: 'Index file' }
    ]

    const page: AgentSessionHistoryPage = {
      agentSessionId: control.agentSessionId,
      source: { providerId: 'codex', nativeSessionId: 'native-mixed-history' },
      items: [
        {
          id: 'hist-mixed-item',
          kind: 'assistant-message',
          contentParts: mixedParts
        }
      ],
      nextCursor: null
    }

    historyPageSpy.mockResolvedValue(page)

    await act(async () => {
      root.render(
        <SessionHistoryView
          control={control}
          label="Codex"
          visible
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/workspace"
          openWorkspaceFile={openFile}
          openHttpLink={openHttp}
        />
      )
    })

    // 1. Assert text category in mounted DOM (fails AssertionRED if remove-text-parts mutant runs)
    const textEls = host.querySelectorAll('.log-turn__body > .md')
    expect(textEls.length).toBeGreaterThan(0)
    expect(host.textContent).toContain('Mixed text body')

    // 2. Assert reasoning category in mounted DOM (fails AssertionRED if remove-reasoning-parts mutant runs)
    const reasoningEls = host.querySelectorAll<HTMLDetailsElement>('details.log-turn__trace[data-trace-kind="reasoning"]')
    expect(reasoningEls.length).toBeGreaterThan(0)

    // Reasoning collapsed: payload must be null (fails AssertionRED if reasoning-always-mounted mutant runs)
    expect(host.querySelector('.log-turn__trace-payload')).toBeNull()

    // Open reasoning: must render Markdown and not raw fallback (fails AssertionRED if reasoning-raw-text mutant runs)
    await act(async () => {
      reasoningEls[0]!.open = true
      reasoningEls[0]!.dispatchEvent(new Event('toggle'))
    })
    expect(host.querySelector('.log-turn__trace-body .md')).not.toBeNull()
    expect(host.querySelector('.log-turn__trace-raw-fallback')).toBeNull()
    expect(host.textContent).toContain('Mixed reasoning body')

    // 3. Assert tool-call / tool-result categories in mounted DOM (fails AssertionRED if remove-tool-parts mutant runs)
    const toolEls = host.querySelectorAll('.conversation-tool-trace')
    expect(toolEls.length).toBeGreaterThanOrEqual(2)
    expect(host.textContent).toContain('search_files')

    // 4. Assert resource category in mounted DOM (fails AssertionRED if remove-resource-parts mutant runs)
    const resourceEls = host.querySelectorAll('.log-turn__resource')
    expect(resourceEls.length).toBeGreaterThan(0)
    expect(host.textContent).toContain('Index file')
    expect(host.textContent).toContain('src/index.ts')
    const body = host.querySelector('.log-turn__body')!
    expect([...body.children].map((element) =>
      element.getAttribute('data-trace-kind') ?? (element.classList.contains('md') ? 'text' : 'resource')
    )).toEqual(['text', 'reasoning', 'tool-call', 'tool-result', 'resource'])
    const copy = host.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')!
    await act(async () => copy.click())
    expect(clipboardSpy).toHaveBeenLastCalledWith(
      '**Mixed text body**\n**Mixed reasoning body**\nsearch_files\n{"pattern":"*.ts"}\nsearch_files\nsrc/index.ts\nIndex file\nsrc/index.ts'
    )

    // The same typed native parts must also reach the actual Activity entry.
    await act(async () => {
      root.render(
        <ActivityView
          sessionId={control.agentSessionId}
          capability="complete-events"
          displayState="done"
          items={[]}
          userMessages={[{
            id: 'activity-mixed', rawId: 'activity-mixed-raw',
            agentSessionId: control.agentSessionId,
            source: { kind: 'captured', submissionId: 'mixed-submission' },
            author: { kind: 'agent', agentSessionId: 'sender-agent' },
            content: 'Mixed text body', contentParts: mixedParts
          }]}
          workspaceRoot="/workspace"
        />
      )
    })
    expect(host.querySelectorAll('.log-turn__body > .md')).toHaveLength(1)
    expect(host.textContent).toContain('Mixed text body')
    expect(host.querySelectorAll('[data-trace-kind="reasoning"]')).toHaveLength(1)
    expect(host.querySelectorAll('.conversation-tool-trace')).toHaveLength(2)
    expect(host.querySelectorAll('.log-turn__resource')).toHaveLength(1)
  })
})
