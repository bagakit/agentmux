import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type {
  AgentSessionHistoryContentPart,
  AgentSessionHistoryPage,
  AgentTimelineItem
} from '@agentmux/core'
import type { AgentSessionControl } from '../src/shared/contracts'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { activityReadingProps } from './helpers/activity-reading-props'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { api } from '../src/renderer/src/lib/api'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})
vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  unobserve() {}
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
const fixtures: Awaited<ReturnType<typeof conversationPagePortFixture>>[] = []
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

})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  window.getSelection()?.removeAllRanges()
  clipboardSpy.mockRestore()
  try {
    for (const f of fixtures) expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
  } finally {
    for (const f of fixtures.splice(0).reverse()) await f.close()
    vi.restoreAllMocks()
  }
})

async function readActivity(page: AgentSessionHistoryPage, items: AgentTimelineItem[] = [], props: Partial<ComponentProps<typeof ActivityView>> = {}) {
  const f = await conversationPagePortFixture(control, page.source, async () => page); fixtures.push(f)
  const stream = await f.publishCaptured(items)
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control, workspaceRoot: _hygiene_fixturePath('workspace'), openWorkspaceFile: openFile, openHttpLink: openHttp })} {...props} />))
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    expect(f.acceptedCaptured(stream)).toBe(true)
    const consumer = inspectConversationConsumers(control).consumers[0]
    expect(consumer?.accepted).not.toBeNull(); expect(consumer?.loading).toBe(false); expect(consumer?.inFlight).toBe(false)
  })
  return f
}
async function revealBody() {
  for (const button of host.querySelectorAll<HTMLButtonElement>('[data-captured-reply-observation] [aria-expanded="false"]')) await act(async () => button.click())
  for (const details of host.querySelectorAll<HTMLDetailsElement>('.conversation-submission-record .message-disclosure:not([open])')) await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  for (const button of [...host.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent === '显示正文')) await act(async () => button.click())
}

describe('Conversation and History shared reading UI presentation', () => {
  it('renders confirmed Agent replies left and both confirmed and unattributed user inputs right through the public Activity window', async () => {
    const item = (id: string, kind: AgentTimelineItem['kind'], content: string, createdAt: number): AgentTimelineItem => ({ id, agentSessionId: control.agentSessionId,
      kind, source: 'native-hook', status: 'complete', title: id, content, createdAt, updatedAt: createdAt })
    const human = { ...item('sub-1', 'user_message', '人类提问：请检查代码。', 1000), source: 'user' as const, authorHuman: true }
    const unknown = { ...item('sub-2', 'user_message', '未核实作者输入。', 1500), source: 'user' as const }
    const agent = { ...item('msg-agent', 'assistant_message', '回答已生成。\n- 列表项一\n- 列表项二\n\n```ts\nconst x = 1\n```', 2000), authorAgentSessionId: control.agentSessionId }
    const machine = item('msg-machine', 'lifecycle', 'System ready.', 2500)
    await readActivity({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'native-reading-ui' }, items: [], nextCursor: null }, [human, unknown, agent, machine],
      { describeSpeaker: speaker => ({ name: speaker.role === 'human' ? 'You' : speaker.role === 'unknown' ? 'Input' : 'Agent' }) })
    await revealBody()
    const reply = host.querySelector<HTMLElement>('[data-message-id="msg-agent"]')!
    expect(reply).not.toBeNull(); expect(reply.dataset.speakerRole).toBe('agent')
    expect(reply.textContent).toContain('回答已生成。'); expect(reply.querySelector('.md-list')).not.toBeNull(); expect(reply.querySelector('.md-block-code')).not.toBeNull()
    const input = host.querySelector<HTMLElement>('[data-submission-id="sub-1"]')!
    expect(input).not.toBeNull(); expect(input.querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('human')
    expect(input.textContent).toContain(human.content)
    const unattributed = host.querySelector<HTMLElement>('[data-submission-id="sub-2"]')!
    expect(unattributed).not.toBeNull(); expect(unattributed.querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('human')
    expect(unattributed.textContent).toContain(unknown.content)
    expect(Reflect.get(unknown, 'authorHuman')).toBeUndefined()
    const group = host.querySelector<HTMLButtonElement>('.wf-head')!; expect(group).not.toBeNull()
    await act(async () => group.click())
    const step = host.querySelector<HTMLElement>('[data-observation-step-id="msg-machine"]')!
    expect(step).not.toBeNull(); expect(step.closest('.log-turn')).toBeNull()
    await act(async () => step.click())
    expect(host.querySelector('.wf-native-process__body')?.textContent).toContain(machine.content)
  })

  it('renders trace-only turn compactly with identity preserved and no heavy header wall', async () => {
    const traceOnlyParts: AgentSessionHistoryContentPart[] = [
      { kind: 'tool-call', name: 'search_files', input: '{"pattern":"*.ts"}', callId: 'call-1' },
      { kind: 'tool-result', name: 'search_files', output: 'src/main.ts\nsrc/lib.ts', callId: 'call-1' },
      { kind: 'resource', resourceType: 'file', reference: _hygiene_fixturePath("workspace/src/main.ts"), label: 'Main source' }
    ]

    await act(async () => {
      root.render(
        <ConversationMessage
          messageId="trace-only-1"
          speaker={{ role: 'agent', id: 'agent-1' }}
          name="Tool Agent"
          content={traceOnlyParts}
          workspaceRoot={_hygiene_fixturePath("workspace")}
        />
      )
    })

    const turn = host.querySelector<HTMLElement>('.log-turn')!
    expect(turn).not.toBeNull()
    expect(turn.dataset.traceOnly).toBe('true')
    expect(turn.querySelector('.log-turn__who')?.textContent).toBe('Tool Agent')
    expect(turn.querySelectorAll('.conversation-tool-trace')).toHaveLength(2)
    expect(turn.querySelector('.conversation-resource-file')).not.toBeNull()
  })

  it('uses the shared Markdown baseline in the actual Activity history entry', async () => {
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

    await readActivity(page)
    await revealBody()

    const turn = host.querySelector<HTMLElement>('.conversation-native-thread .log-turn')
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
          workspaceRoot={_hygiene_fixturePath("workspace")}
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

  it('reads all typed mixed part categories through the one public Activity entry with exact Copy order', async () => {
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

    await readActivity(page)
    await revealBody()

    // 1. Assert text category in mounted DOM (fails AssertionRED if remove-text-parts mutant runs)
    const textEls = host.querySelectorAll('.log-turn__body .log-turn__text .md')
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
    const resourceEls = host.querySelectorAll('.conversation-resource-file')
    expect(resourceEls.length).toBeGreaterThan(0)
    expect(host.textContent).toContain('Index file')
    const reference = host.querySelector<HTMLDetailsElement>('.conversation-resource-file__reference')!
    expect(reference).not.toBeNull()
    await act(async () => { reference.open = true; reference.dispatchEvent(new Event('toggle')) })
    await act(async () => reference.querySelector<HTMLButtonElement>('[aria-label="Copy file reference"]')!.click())
    expect(clipboardSpy).toHaveBeenLastCalledWith('src/index.ts')
    const body = host.querySelector('.log-turn__body')!
    expect([...body.querySelectorAll('.log-turn__text, [data-trace-kind], .conversation-resource-file')].map((element) =>
      element.getAttribute('data-trace-kind') ?? (element.classList.contains('log-turn__text') ? 'text' : 'resource')
    )).toEqual(['text', 'reasoning', 'tool-call', 'tool-result', 'resource'])
    const copy = host.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')!
    await act(async () => copy.click())
    expect(clipboardSpy).toHaveBeenLastCalledWith(
      '**Mixed text body**\n**Mixed reasoning body**\nsearch_files\n{"pattern":"*.ts"}\nsearch_files\nsrc/index.ts\nIndex file\nsrc/index.ts'
    )


  })
})
