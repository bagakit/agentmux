import { fixturePath } from '../../../test/fixture-values.mjs'
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxInteractionRequest, AgentMuxInteractionResponse } from '@agentmux/core'
import { AgentComposer, AgentInteractionCard, ConversationMessage, ClientUiProvider, type ClientUiPlatform } from '../src'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const mounted: { root: Root; element: HTMLElement }[] = []
const platform = (overrides: Partial<ClientUiPlatform> = {}): ClientUiPlatform => ({
  copyText: async () => true,
  overlayContainer: () => document.body,
  bindComposerFocus: () => () => {},
  renderMessageAvatar: ({ name }) => <span role="img" aria-label={name}>{name.slice(0, 1)}</span>,
  renderProjectIcon: project => <span>{project.name}</span>,
  renderIcon: name => <span data-icon={name} />,
  ...overrides
})
async function mount(content: ReactNode, adapter: ClientUiPlatform = platform()) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  mounted.push({ root, element })
  await act(async () => { root.render(<ClientUiProvider platform={adapter}>{content}</ClientUiProvider>) })
  return element
}
async function click(element: Element): Promise<void> {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
function button(element: HTMLElement, name: string): HTMLButtonElement {
  const found = [...element.querySelectorAll('button')].find(candidate => candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name)
  expect(found, `Actual rendered action ${name}`).toBeDefined()
  return found!
}
afterEach(async () => {
  for (const item of mounted.splice(0)) {
    await act(async () => item.root.unmount())
    item.element.remove()
  }
})

describe('one shared conversation composition with explicit client IO', () => {
  it('renders recorded authorship and delegates safe file/link destinations without executable output', async () => {
    const openFile = vi.fn(), openHttp = vi.fn()
    const element = await mount(<ConversationMessage messageId="native-1" speaker={{ role: 'unknown', id: 'unknown' }}
      content="Read [source](src/main.ts:7) and [docs](https://example.test/docs). [unsafe](javascript:alert(1))"
      workspaceRoot={fixturePath("project")} openWorkspaceFile={openFile} openHttpLink={openHttp}
      inputSource={{ kind: 'native', providerId: 'codex', nativeSessionId: 'native-session', recordId: 'record-1' }} />)
    expect(element.textContent).toContain('You')
    expect(element.querySelector('a, script, iframe')).toBeNull()
    await click(button(element, 'source'))
    await click(button(element, 'docs'))
    expect(openFile).toHaveBeenCalledWith('src/main.ts', { line: 7 })
    expect(openHttp).toHaveBeenCalledWith('https://example.test/docs', expect.objectContaining({ metaKey: false, ctrlKey: false }))
    expect([...element.querySelectorAll('button')].some(candidate => candidate.textContent === 'unsafe')).toBe(false)
    await click(button(element, 'Message details'))
    expect(element.textContent).toContain('Not recorded · shown as You')
    expect(element.textContent).toContain('record-1')
  })

  it('keeps a copy failure visible and copies the same exact readable body on retry', async () => {
    const copy = vi.fn<ClientUiPlatform['copyText']>()
      .mockImplementationOnce(async (_text, report) => { report(new Error('clipboard unavailable')); return false })
      .mockResolvedValueOnce(true)
    const element = await mount(<ConversationMessage speaker={{ role: 'agent', id: 'agent-original' }}
      messageId="message-1" content="完整消息" />, platform({ copyText: copy }))
    expect(element.textContent).toContain('完整消息')
    await click(button(element, 'Copy message'))
    expect(copy).toHaveBeenNthCalledWith(1, '完整消息', expect.any(Function))
    expect(element.textContent).toContain('Copy failed')
    await click(button(element, 'Copy message'))
    expect(copy).toHaveBeenNthCalledWith(2, '完整消息', expect.any(Function))
    expect(element.textContent).not.toContain('Copy failed')
  })

  it('submits the original request option once and waits for authoritative confirmation', async () => {
    const request: AgentMuxInteractionRequest = {
      kind: 'permission', id: 'request-original', agentSessionId: 'session-original', title: 'Allow write?',
      options: [{ id: 'allow-write', label: 'Allow once', kind: 'allow-once' }, { id: 'deny', label: 'Deny', kind: 'reject-once' }],
      evidence: { source: 'native-hook', observedAt: 1, run: { runId: 'run-original' } }
    }
    const respond = vi.fn<(response: AgentMuxInteractionResponse) => Promise<void>>().mockResolvedValue()
    const element = await mount(<AgentInteractionCard request={request} onRespond={respond} />)
    await click(button(element, 'Allow once'))
    expect(respond).toHaveBeenCalledExactlyOnceWith({ kind: 'permission', requestId: 'request-original', decision: { outcome: 'selected', optionId: 'allow-write' } })
    expect(element.textContent).toContain('Waiting for confirmation')
    expect([...element.querySelectorAll('button')]).toHaveLength(3)
    expect([...element.querySelectorAll('button')].map(candidate => candidate.disabled)).toEqual([true, true, true])
    await click(button(element, 'Allow once'))
    expect(respond).toHaveBeenCalledTimes(1)
  })

  it('keeps the maintained editor controlled, preserves IME Enter, and releases host focus registration', async () => {
    const unregister = vi.fn(), bind = vi.fn<ClientUiPlatform['bindComposerFocus']>(() => unregister), submit = vi.fn(), change = vi.fn()
    function Composer() {
      const [draft, setDraft] = useState('未完成')
      return <AgentComposer value={draft} disabled={false} placeholder="Message" onChange={value => { change(value); setDraft(value) }} onSubmit={submit} />
    }
    const element = await mount(<Composer />, platform({ bindComposerFocus: bind }))
    const editor = element.querySelector<HTMLElement>('[contenteditable="true"]')
    expect(editor).not.toBeNull()
    expect(editor?.textContent).toContain('未完成')
    expect(bind).toHaveBeenCalledTimes(1)
    await act(async () => { editor!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 229, isComposing: true })) })
    expect(submit).not.toHaveBeenCalled()
    await click(button(element, 'Send'))
    expect(submit).toHaveBeenCalledTimes(1)
    await act(async () => {
      const paste = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(paste, 'clipboardData', { value: { items: [], getData: () => '新输入' } })
      editor!.dispatchEvent(paste)
    })
    expect(change).toHaveBeenCalled()
    expect(editor?.textContent).toContain('新输入')
    const item = mounted.pop()!
    await act(async () => item.root.unmount())
    item.element.remove()
    expect(unregister).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing platform instead of borrowing Electron or a silent default', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    expect(() => renderToStaticMarkup(<ConversationMessage content="readable" />)).toThrow('explicit client platform adapter')
  })
})
