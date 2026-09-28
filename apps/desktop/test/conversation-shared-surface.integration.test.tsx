// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import type { AgentSessionControl } from '../src/shared/contracts'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { SessionHistoryView } from '../src/renderer/src/components/SessionHistoryView'
import { api } from '../src/renderer/src/lib/api'
import * as markdown from '../src/renderer/src/lib/agent-markdown'

type Entry = 'live' | 'history'

const control: AgentSessionControl = {
  kind: 'agent',
  hostId: 'local',
  agentSessionId: 'shared-dom-agent',
  run: { runId: 'shared-dom-run' }
}

const SOURCE = '  source **message** with [guide](src/guide.ts:4) and [web](https://docs.example.test/read)\n'

let host: HTMLDivElement
let root: Root
let annotate: ReturnType<typeof vi.fn>
let openFile: ReturnType<typeof vi.fn>
let openHttp: ReturnType<typeof vi.fn>
let clipboardSpy: ReturnType<typeof vi.spyOn>
let historyPageSpy: ReturnType<typeof vi.spyOn>

function page(parts: AgentSessionHistoryContentPart[]): AgentSessionHistoryPage {
  return {
    agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'fixture-native-identity' },
    items: [{ id: 'same-message-id', kind: 'assistant-message', contentParts: parts }],
    nextCursor: null
  }
}

function item(content: string): AgentTimelineItem {
  return {
    id: 'same-message-id',
    agentSessionId: control.agentSessionId,
    kind: 'assistant_message',
    status: 'complete',
    source: 'native-hook',
    createdAt: 1,
    updatedAt: 1,
    title: 'Actual live message',
    content
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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
  annotate = vi.fn()
  openFile = vi.fn()
  openHttp = vi.fn()
  clipboardSpy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  historyPageSpy = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page([{ kind: 'text', text: SOURCE }]))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  window.getSelection()?.removeAllRanges()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clipboardSpy.mockRestore()
  historyPageSpy.mockRestore()
})

async function mount(entry: Entry, content = SOURCE, parts?: AgentSessionHistoryContentPart[]) {
  historyPageSpy.mockResolvedValue(page(parts ?? [{ kind: 'text', text: content }]))
  await act(async () =>
    root.render(
      entry === 'live' ? (
        <ActivityView
          sessionId={control.agentSessionId}
          capability="complete-events"
          displayState="done"
          items={[item(content)]}
          workspaceRoot="/synthetic"
          describeSpeaker={() => ({ name: 'Agent' })}
          onAnnotate={annotate}
          openWorkspaceFile={openFile}
          openHttpLink={openHttp}
        />
      ) : (
        <SessionHistoryView
          control={control}
          label="Agent"
          visible
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/synthetic"
          openWorkspaceFile={openFile}
          openHttpLink={openHttp}
        />
      )
    )
  )
  expect(host.querySelectorAll('.log-turn')).toHaveLength(1)
  expect(host.querySelector('.log-turn__body')).not.toBeNull()
}

function copyButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('.log-turn [title="Copy message"]')
  expect(button).not.toBeNull()
  return button!
}

function selection(body: HTMLElement, node: Node, start: number, end: number) {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  const current = window.getSelection()!
  current.removeAllRanges()
  current.addRange(range)
  expect(current.toString().length).toBeGreaterThan(0)
  body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
}

async function addNote() {
  const textarea = host.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')
  expect(textarea).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea!,
      'Exact selected occurrence'
    )
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const submit = [...host.querySelectorAll<HTMLButtonElement>('.log-turn__annotation-actions button')].find(
    (btn) => btn.textContent === 'Add note to reply'
  )
  expect(submit).toBeDefined()
  expect(submit!.disabled).toBe(false)
  await act(async () => submit!.click())
  expect(annotate).toHaveBeenCalledTimes(1)
  return annotate.mock.calls[0]![0]
}

for (const entry of ['live', 'history'] as const) {
  describe(`${entry} actual shared entry`, () => {
    it('copies exact same source and opens file/http through host seams', async () => {
      await mount(entry)
      const file = host.querySelector<HTMLButtonElement>('.md-link--file')
      const http = [...host.querySelectorAll<HTMLButtonElement>('.md-link')].find(
        (button) => button.textContent === 'web'
      )
      expect(file).not.toBeNull()
      expect(http).toBeDefined()
      await act(async () => {
        file!.click()
        http!.click()
        copyButton().click()
      })
      expect(openFile).toHaveBeenCalledExactlyOnceWith('src/guide.ts', { line: 4 })
      expect(openHttp).toHaveBeenCalledExactlyOnceWith(
        'https://docs.example.test/read',
        expect.objectContaining({ metaKey: false, ctrlKey: false })
      )
      expect(clipboardSpy).toHaveBeenCalledExactlyOnceWith(SOURCE)
      expect(copyButton().getAttribute('aria-label')).toBe('Message copied')
      if (entry === 'history') {
        expect(host.querySelector('.log-turn')!.getAttribute('data-status')).toBeNull()
        expect(host.querySelector('.log-turn__time')).toBeNull()
        expect(historyPageSpy).toHaveBeenCalledExactlyOnceWith(control, undefined)
      }
    })

    it('makes rejected clipboard copy visibly distinguishable and retryable', async () => {
      await mount(entry, 'Copy this original source')
      clipboardSpy.mockRejectedValueOnce(new Error('Clipboard write denied'))
      await act(async () => copyButton().click())
      const message = host.querySelector<HTMLElement>('.log-turn')!
      const notice = message.querySelector<HTMLElement>('[role="alert"], [role="status"]')
      expect(clipboardSpy).toHaveBeenCalledExactlyOnceWith('Copy this original source')
      expect(copyButton().getAttribute('aria-label')).not.toBe('Message copied')
      expect(copyButton().disabled).toBe(false)
      expect(notice?.textContent ?? '', 'A rejected copy must not be silently identical to idle').toMatch(
        /cop(y|ied|ying)|clipboard/i
      )
    })

    it('does not let a prior success timer erase a newer copy acknowledgement', async () => {
      await mount(entry, 'Repeated successful copy')
      vi.useFakeTimers()
      await act(async () => copyButton().click())
      expect(copyButton().getAttribute('aria-label')).toBe('Message copied')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800)
      })
      await act(async () => copyButton().click())
      expect(clipboardSpy).toHaveBeenCalledTimes(2)
      expect(copyButton().getAttribute('aria-label')).toBe('Message copied')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800)
      })
      expect(copyButton().getAttribute('aria-label')).toBe('Message copied')
    })

    it('preserves the latest copy success when an older in-flight request later rejects', async () => {
      await mount(entry, 'Same original source')
      let rejectFirst!: (error: Error) => void
      clipboardSpy.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject
          })
      )
      await act(async () => copyButton().click())
      expect(clipboardSpy).toHaveBeenCalledTimes(1)
      expect(copyButton().getAttribute('aria-label')).toBe('Copy message')
      await act(async () => copyButton().click())
      expect(clipboardSpy).toHaveBeenCalledTimes(2)
      expect(copyButton().getAttribute('aria-label')).toBe('Message copied')
      await act(async () => rejectFirst(new Error('Older request rejected')))
      expect(copyButton().getAttribute('aria-label')).toBe('Message copied')
    })

    it('allows a failed clipboard action to retry and then shows genuine acceptance', async () => {
      await mount(entry, 'Retry original source')
      clipboardSpy.mockRejectedValueOnce(new Error('First write denied'))
      await act(async () => copyButton().click())
      expect(copyButton().disabled).toBe(false)
      expect(copyButton().getAttribute('aria-label')).toBe('Copy message')
      await act(async () => copyButton().click())
      expect(clipboardSpy.mock.calls).toEqual([['Retry original source'], ['Retry original source']])
      expect(copyButton().getAttribute('aria-label')).toBe('Message copied')
    })
  })
}

it('binds a selected second repeated occurrence to quote and note without guessed coordinates', async () => {
  const content = 'Alpha shared phrase. Beta shared phrase.'
  const quote = 'shared phrase'
  const second = content.lastIndexOf(quote)
  expect(second).toBeGreaterThan(content.indexOf(quote))
  await mount('live', content)
  const body = host.querySelector<HTMLElement>('.log-turn__body')!
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  const node = walker.nextNode()!
  expect(node.textContent).toBe(content)
  await act(async () => selection(body, node, second, second + quote.length))
  const annotation = await addNote()
  expect(annotation.quote).toBe(quote)
  expect(annotation.messageId).toBe('same-message-id')
  expect(annotation.note).toBe('Exact selected occurrence')
  // start / end 已删除，不再输出猜测或错误的数字坐标
  expect((annotation as Record<string, unknown>).start).toBeUndefined()
  expect((annotation as Record<string, unknown>).end).toBeUndefined()
})

it('does not manufacture zero source offsets or fake coordinates for a rendered Markdown range', async () => {
  const content = 'Intro **bold** and [guide](src/guide.ts:4) tail.'
  await mount('live', content)
  const body = host.querySelector<HTMLElement>('.log-turn__body')!
  const startNode = body.querySelector('strong')!.firstChild!
  const endNode = body.querySelector('.md-link--file')!.firstChild!
  const range = document.createRange()
  range.setStart(startNode, 0)
  range.setEnd(endNode, 5)
  const current = window.getSelection()!
  current.removeAllRanges()
  current.addRange(range)
  expect(current.toString()).toBe('bold and guide')
  await act(async () => body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  const annotation = await addNote()
  expect(annotation.quote).toBe('bold and guide')
  expect(annotation.messageId).toBe('same-message-id')
  expect(annotation.note).toBe('Exact selected occurrence')
  // 不再把未匹配到的 Markdown 选区 clamp 成 start: 0 / end: 14
  expect((annotation as Record<string, unknown>).start).toBeUndefined()
  expect((annotation as Record<string, unknown>).end).toBeUndefined()
})

it('keeps ordered rich native parts, failure and unknown metadata without inventing resource links', async () => {
  const parts: AgentSessionHistoryContentPart[] = [
    { kind: 'text', text: 'first' },
    { kind: 'reasoning', text: 'reason' },
    { kind: 'tool-call', name: 'shell', input: 'first command', callId: 'call-a' },
    { kind: 'tool-result', name: 'shell', output: 'actual failure', callId: 'call-a', failed: true },
    { kind: 'resource', resourceType: 'file', reference: 'opaque-resource', label: 'File resource' },
    { kind: 'text', text: 'last' }
  ]
  await mount('history', '', parts)
  const body = host.querySelector<HTMLElement>('.log-turn__body')!
  const order = [...body.children].map(
    (child) => child.getAttribute('data-trace-kind') ?? (child.matches('.log-turn__resource') ? 'resource' : 'text')
  )
  expect(order).toEqual(['text', 'reasoning', 'tool-call', 'tool-result', 'resource', 'text'])
  expect(body.querySelector('[data-trace-kind="tool-result"]')!.getAttribute('data-status')).toBe('failed')
  expect(body.querySelector('.log-turn__resource code')!.textContent).toBe('opaque-resource')
  expect(body.querySelector('.log-turn__resource button')).toBeNull()
  expect(host.querySelector('.log-turn__annotation')).toBeNull()
  await act(async () => copyButton().click())
  expect(clipboardSpy).toHaveBeenCalledExactlyOnceWith(
    'first\nreason\nshell\nfirst command\nshell\nactual failure\nFile resource\nopaque-resource\nlast'
  )
})

it('keeps expanded native tool identity when Latest replaces the same message parts order (T028 boundary)', async () => {
  const a: AgentSessionHistoryContentPart = { kind: 'tool-call', name: 'shell', input: 'command A', callId: 'call-a' }
  const b: AgentSessionHistoryContentPart = { kind: 'tool-call', name: 'shell', input: 'command B', callId: 'call-b' }
  await mount('history', '', [a, b])
  const before = [...host.querySelectorAll<HTMLButtonElement>('.conversation-tool-trace__row')]
  expect(before).toHaveLength(2)
  await act(async () => before[0]!.click())
  expect(before[0]!.parentElement!.querySelector('pre')!.textContent).toBe('command A')
  historyPageSpy.mockResolvedValueOnce(page([b, a]))
  const latest = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === ' Latest' || button.textContent?.trim() === 'Latest'
  )
  expect(latest).toBeDefined()
  await act(async () => latest!.click())
  const expanded = [...host.querySelectorAll<HTMLElement>('.conversation-tool-trace')].filter(
    (trace) => trace.querySelector('button')!.getAttribute('aria-expanded') === 'true'
  )
  expect(expanded).toHaveLength(1)
  expect(expanded[0]!.querySelector('pre')!.textContent).toBe('command A')
})

it('retains the actual message body DOM node across copy and selection popover state changes', async () => {
  await mount('live', '**Selected** source text')
  const before = host.querySelector('.log-turn__body p')
  expect(before).not.toBeNull()
  expect(before?.textContent).toBe('Selected source text')
  expect(before?.isConnected).toBe(true)

  // 1. Local copy state change does not remount the body node
  const button = copyButton()
  await act(async () => button.click())
  expect(clipboardSpy).toHaveBeenCalledWith('**Selected** source text')
  expect(button.getAttribute('aria-label')).toBe('Message copied')
  expect(host.querySelector('.log-turn__body p')).toBe(before)
  expect(before?.isConnected).toBe(true)

  // 2. Selection popover opening does not remount the body node
  const body = host.querySelector<HTMLElement>('.log-turn__body')!
  const textNode = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!
  await act(async () => selection(body, textNode, 0, 8))
  expect(host.querySelector('.log-turn__annotation')).not.toBeNull()
  expect(host.querySelector('.log-turn__body p')).toBe(before)
  expect(before?.isConnected).toBe(true)

  // 3. Typing in popover does not remount the body node
  const textarea = host.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Some note')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(host.querySelector('.log-turn__body p')).toBe(before)
  expect(before?.isConnected).toBe(true)

  // 4. Cancelling popover does not remount the body node
  const cancel = [...host.querySelectorAll<HTMLButtonElement>('.log-turn__annotation-actions button')].find(
    (btn) => btn.textContent === 'Cancel'
  )!
  await act(async () => cancel.click())
  expect(host.querySelector('.log-turn__annotation')).toBeNull()
  expect(host.querySelector('.log-turn__body p')).toBe(before)
  expect(before?.isConnected).toBe(true)
})

it('preserves paragraph identity and updates text in-place when live message content updates', async () => {
  await mount('live', 'Initial streaming content')
  const before = host.querySelector('.log-turn__body p')
  expect(before).not.toBeNull()
  expect(before?.textContent).toBe('Initial streaming content')
  expect(before?.isConnected).toBe(true)

  await mount('live', 'Initial streaming content with additional tokens')
  const after = host.querySelector('.log-turn__body p')
  expect(after).toBe(before)
  expect(after?.textContent).toBe('Initial streaming content with additional tokens')
  expect(before?.isConnected).toBe(true)
})

it('monotonically invalidates copy action identity on unmount so delayed async callbacks are discarded', async () => {
  let rejectPending!: (error: Error) => void
  clipboardSpy.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectPending = reject
      })
  )
  await mount('live', 'First message to be unmounted')
  const firstButton = copyButton()
  await act(async () => firstButton.click())
  expect(clipboardSpy).toHaveBeenCalledTimes(1)

  // Unmount first instance
  await act(async () => root.unmount())
  root = createRoot(host)

  // Mount second instance
  await mount('live', 'Second fresh message')
  const secondButton = copyButton()
  expect(secondButton.getAttribute('aria-label')).toBe('Copy message')
  expect(host.querySelector('.log-turn__copy-error')).toBeNull()

  // Settle delayed rejection from older unmounted instance
  await act(async () => rejectPending(new Error('Stale write rejected')))

  // Second instance must remain untouched and not show stale failure
  expect(secondButton.getAttribute('aria-label')).toBe('Copy message')
  expect(host.querySelector('.log-turn__copy-error')).toBeNull()
})

it('renders a repeated readonly part reference without duplicate React keys', async () => {
  const part: AgentSessionHistoryContentPart = { kind: 'reasoning', text: 'same valid part twice' }
  const pageWithDupParts: AgentSessionHistoryPage = {
    agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'synthetic-native' },
    items: [{ id: 'repeated-part-message', kind: 'assistant-message', contentParts: [part, part] }],
    nextCursor: null
  }
  historyPageSpy.mockResolvedValueOnce(pageWithDupParts)
  const errors: unknown[][] = []
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args)
  })
  try {
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={control}
          label="Agent"
          visible
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/synthetic"
          openWorkspaceFile={openFile}
          openHttpLink={openHttp}
        />
      )
    )
    expect(host.querySelectorAll('.log-turn__trace')).toHaveLength(2)
    expect(host.querySelectorAll('.log-turn__trace-payload')).toHaveLength(0)
    await act(async () => {
      for (const details of host.querySelectorAll<HTMLDetailsElement>('.log-turn__trace')) {
        details.open = true
        details.dispatchEvent(new Event('toggle'))
      }
    })
    expect([...host.querySelectorAll('.log-turn__trace-body')].map((p) => p.textContent)).toEqual([
      'same valid part twice',
      'same valid part twice'
    ])
    const keyWarnings = errors.filter(
      (args) => String(args[0]).includes('same key') || String(args[0]).includes('unique "key"')
    )
    expect(keyWarnings).toHaveLength(0)
  } finally {
    errorSpy.mockRestore()
  }
})

it('assigns distinct local keys to parts with duplicate callIds without key warnings or colliding expansion', async () => {
  const dup1: AgentSessionHistoryContentPart = {
    kind: 'tool-call',
    name: 'shell',
    input: 'first cmd',
    callId: 'dup-id'
  }
  const dup2: AgentSessionHistoryContentPart = {
    kind: 'tool-call',
    name: 'shell',
    input: 'second cmd',
    callId: 'dup-id'
  }
  const pageWithDupCallIds: AgentSessionHistoryPage = {
    agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'synthetic-native' },
    items: [{ id: 'dup-call-id-message', kind: 'assistant-message', contentParts: [dup1, dup2] }],
    nextCursor: null
  }
  historyPageSpy.mockResolvedValueOnce(pageWithDupCallIds)
  const errors: unknown[][] = []
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args)
  })
  try {
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={control}
          label="Agent"
          visible
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/synthetic"
          openWorkspaceFile={openFile}
          openHttpLink={openHttp}
        />
      )
    )
    const traces = host.querySelectorAll<HTMLButtonElement>('.conversation-tool-trace__row')
    expect(traces).toHaveLength(2)
    const keyWarnings = errors.filter(
      (args) => String(args[0]).includes('same key') || String(args[0]).includes('unique "key"')
    )
    expect(keyWarnings).toHaveLength(0)

    // Expand first tool trace; second must remain closed
    await act(async () => traces[0]!.click())
    expect(traces[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(traces[1]!.getAttribute('aria-expanded')).toBe('false')
  } finally {
    errorSpy.mockRestore()
  }
})

it('does not re-parse Markdown during local copy and annotation note keystrokes', async () => {
  const parser = vi.spyOn(markdown, 'parseAgentMarkdown')
  const content = '**stable body** ' + 'long prose '.repeat(100)
  await mount('live', content)
  const mountCalls = parser.mock.calls.length
  expect(mountCalls).toBeGreaterThan(0)

  // 1. Copy does not trigger re-parse
  const button = copyButton()
  await act(async () => button.click())
  expect(parser.mock.calls.length).toBe(mountCalls)

  // 2. Selection popover opening does not re-parse
  const body = host.querySelector<HTMLElement>('.log-turn__body')!
  const textNode = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!
  await act(async () => selection(body, textNode, 0, 6))
  expect(parser.mock.calls.length).toBe(mountCalls)

  // 3. Typing in note textarea does not re-parse
  const textarea = host.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!
  for (const text of ['n', 'no', 'not', 'note']) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  expect(parser.mock.calls.length).toBe(mountCalls)
  parser.mockRestore()
})
