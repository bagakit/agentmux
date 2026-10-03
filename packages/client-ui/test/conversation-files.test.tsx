import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { conversationFiles } from '../src/lib/conversation-files.js'
import { ConversationMessage } from '../src/components/ConversationMessage.js'
import type { ConversationMessageProps } from '../src/components/ConversationMessage.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationView } from '../src/components/ConversationView.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: ReturnType<typeof createRoot>[] = []
const platform: ClientUiPlatform = {
  copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: ({ name }) => <span>{name.slice(0, 1)}</span>,
  renderProjectIcon: project => <span>{project.name}</span>, renderProjectLabel: project => <span>{project.name}</span>,
  renderIcon: name => <span data-icon={name} />
}
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren() })
const text = '[Report](out/report.pdf) and `src/main.ts:7:3` ![Chart](out/chart.png) [Report again](out/report.pdf)'

it('indexes original explicit references and positions, with no guessed ownership or outside destinations', () => {
  const files = conversationFiles([{ kind: 'text', text }, { kind: 'resource', resourceType: 'file', reference: 'out/data.csv' }], fixturePath("project"))
  expect(files.map(file => [file.reference.path, file.reference.line, file.reference.column, file.kind])).toEqual([
    ['out/report.pdf', undefined, undefined, 'document'], ['src/main.ts', 7, 3, 'file'], ['out/chart.png', undefined, undefined, 'image'], ['out/data.csv', undefined, undefined, 'document']
  ])
  expect(conversationFiles([{ kind: 'text', text: '[outside](../secret.txt) [remote](https://example.test/x.pdf) [encoded](..%2fsecret.txt) [script](javascript:alert(1))' }], fixturePath("project"))).toEqual([])
})

it('does not decorate quoted examples, fenced code, removed text or tool payloads as reply files', () => {
  const files = conversationFiles([{ kind: 'text', text: '> [example](secret.txt)\n\n```md\n[out](example.pdf)\n```\n\n~~[old](removed.txt)~~\n\n[actual](current.md)' },
    { kind: 'tool-result', name: 'tool', output: '[trace](trace.txt)', isError: false }], fixturePath("project"))
  expect(files.map(file => file.reference.path)).toEqual(['current.md'])
})

async function mount(props: Partial<ConversationMessageProps> = {}) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  const open = vi.fn()
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage messageId="reply-original" speaker={{ role: 'agent', id: 'same' }}
    conversationSessionId="same" status="complete" content={text} workspaceRoot={fixturePath("project")} openWorkspaceFile={open} {...props} /></ClientUiProvider>))
  return { container, open }
}

it('actual shared reply opens the exact original line and leaves original body copyable without reading files', async () => {
  const { container, open } = await mount()
  const items = [...container.querySelectorAll<HTMLButtonElement>('.conversation-file')]
  expect(items.map(item => item.getAttribute('aria-label'))).toEqual(['Open out/report.pdf', 'Open src/main.ts:7:3', 'Open out/chart.png'])
  expect(open).not.toHaveBeenCalled()
  expect(container.querySelector('.log-turn__text')?.textContent).toContain('Report')
  await act(async () => items[1]!.click())
  expect(open).toHaveBeenCalledExactlyOnceWith('src/main.ts', { line: 7, column: 3 })
})

it.each([
  { speaker: { role: 'human' as const, id: 'person' } }, { status: 'streaming' as const },
  { status: 'failed' as const }, { status: 'unverified' as const }, { compact: true },
  { messagePhase: 'progress' as const }, { speaker: { role: 'agent' as const, id: 'peer' } }
])('preserves ordinary incoming/unfinished/compact/progress messages without a file-result claim: %j', async props => {
  const { container, open } = await mount(props)
  expect(container.querySelector('.log-turn__text')).not.toBeNull()
  expect(container.querySelector('.conversation-files')).toBeNull()
  expect(open).not.toHaveBeenCalled()
})

it('retains all explicit files in a compact disclosure instead of dropping a seventh result', async () => {
  const content = Array.from({ length: 8 }, (_, i) => `[file ${i}](out/${i}.md)`).join(' ')
  const { container } = await mount({ content })
  expect(container.querySelectorAll('.conversation-file')).toHaveLength(8)
  expect(container.querySelector('.conversation-files__more summary')?.textContent).toBe('2 more files')
  expect(container.querySelector('.conversation-files__more')?.hasAttribute('open')).toBe(false)
})

it('actual native reader indexes final Provider replies while unknown/progress/user records remain original', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  const open = vi.fn()
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationView sessionId="same"
    workspaceRoot={fixturePath("project")} openWorkspaceFile={open} page={{ agentSessionId: 'same', source: { providerId: 'codex', nativeSessionId: 'original-native' }, nextCursor: null, items: [
      { id: 'final', kind: 'assistant-message', messagePhase: 'final', contentParts: [{ kind: 'text', text: '[report](out/final.pdf)' }] },
      { id: 'unknown', kind: 'assistant-message', contentParts: [{ kind: 'text', text: '[unknown](out/unknown.pdf)' }] },
      { id: 'progress', kind: 'assistant-message', messagePhase: 'progress', completedAt: 1, contentParts: [{ kind: 'text', text: '[progress](out/progress.pdf)' }] },
      { id: 'completed', kind: 'assistant-message', completedAt: 2, contentParts: [{ kind: 'text', text: '[completed](out/completed.pdf)' }] },
      { id: 'user', kind: 'user-message', messagePhase: 'final', contentParts: [{ kind: 'text', text: '[input](out/input.pdf)' }] }
    ] }} /></ClientUiProvider>))
  expect([...container.querySelectorAll('.conversation-file')].map(item => item.getAttribute('aria-label'))).toEqual(['Open out/final.pdf', 'Open out/completed.pdf'])
  expect(container.querySelectorAll('.log-turn__text')).toHaveLength(5)
  expect(open).not.toHaveBeenCalled()
})
