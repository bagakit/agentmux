import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryResourceRequest } from '@agentmux/core'
import { ConversationMessage } from '../src/components/ConversationMessage.js'
import type { ConversationHistoryResourceReader } from '../src/components/ConversationResourceImage.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { contentFixture, record } from './fixtures/native-history-content/content.js'

let root: Root, container: HTMLDivElement
const copy = vi.fn(async (_value: string) => true)
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const body = 'BEGIN 原生🙂\n' + 'Original native words 中文🙂. '.repeat(6_000) + '\nEND 原生完整'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+3fVbWQAAAABJRU5ErkJggg=='

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  copy.mockClear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(label))
  expect(button, label).toBeDefined(); await act(async () => button!.click())
}

it('the shared message reads an unmanaged native text part only on request, across exact bounded fragments without a fake Session', async () => {
  const fixture = contentFixture({ kind: 'text', text: body })
  const read: ConversationHistoryResourceReader = async input => {
    const { agentSessionId: _managedId, ...native } = await fixture.read(input)
    expect(Object.hasOwn(native, 'agentSessionId')).toBe(false)
    return native
  }
  await act(async () => root.render(<ClientUiProvider platform={platform}>
    <ConversationMessage compact messageId="unmanaged-original" content={[{ kind: 'text', text: 'Saved context' }, fixture.part]}
      nativeResourceRecord={record} readHistoryResource={read} />
  </ClientUiProvider>))
  expect(fixture.requests).toHaveLength(0)
  expect(container.textContent).toContain('Saved context')
  await click('Read complete content')
  expect(fixture.requests.length).toBeGreaterThan(1)
  expect(fixture.requests.every(input => input.maxBytes === 128 * 1024 && input.partIndex === 1 &&
    input.recordId === record.recordId && input.turnId === record.turnId &&
    input.source.nativeSessionId === record.source.nativeSessionId && input.expectedReference === fixture.part.reference)).toBe(true)
  expect(fixture.requests.map(input => input.offsetBytes)).toEqual(fixture.requests.map((_input, index) => index * 128 * 1024))
  expect(container.textContent).toContain('END 原生完整')
  await click('Copy complete content')
  expect(copy.mock.calls.at(-1)?.[0]).toBe(body)
})

it.each(['native-to-managed', 'managed-to-native', 'managed-to-other-managed'] as const)(
  'the actual shared content face rejects %s identity changes between text fragments', async change => {
    const fixture = contentFixture({ kind: 'text', text: body })
    const read: ConversationHistoryResourceReader = async input => {
      const { agentSessionId: _managedId, ...result } = await fixture.read(input)
      const first = fixture.requests.length === 1
      if (change === 'native-to-managed') return first ? result : { ...result, agentSessionId: 'appearing-session' }
      if (change === 'managed-to-native') return first ? { ...result, agentSessionId: 'original-session' } : result
      return { ...result, agentSessionId: first ? 'original-session' : 'another-session' }
    }
    await act(async () => root.render(<ClientUiProvider platform={platform}>
      <ConversationMessage compact messageId="original" content={[fixture.part]} nativeResourceRecord={record} readHistoryResource={read} />
    </ClientUiProvider>))
    await click('Read complete content')
    expect(fixture.requests).toHaveLength(2)
    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert!.textContent).toMatch(/another recorded resource|identity/i)
    expect(container.querySelector('.log-turn__text')).toBeNull()
    expect(copy).not.toHaveBeenCalled()
  }
)

it('a pending prior native fragment cannot continue or publish after selecting another saved conversation', async () => {
  const fixture = contentFixture({ kind: 'text', text: body })
  let release!: () => void
  const read: ConversationHistoryResourceReader = vi.fn(async input => {
    await new Promise<void>(resolve => { release = resolve })
    const { agentSessionId: _managedId, ...native } = await fixture.read(input)
    return native
  })
  await act(async () => root.render(<ClientUiProvider platform={platform}>
    <ConversationMessage key="old-source" compact content={[fixture.part]} nativeResourceRecord={record} readHistoryResource={read} />
  </ClientUiProvider>))
  await click('Read complete content')
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => root.render(<ClientUiProvider platform={platform}>
    <ConversationMessage key="current-source" compact content="Current saved conversation" />
  </ClientUiProvider>))
  await act(async () => release())
  expect(read).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('Current saved conversation')
  expect(container.textContent).not.toContain('BEGIN 原生')
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('the shared selected-record image face reads the exact native resource without an AgentSession ID', async () => {
  const reference = 'recorded:source-image'
  const read: ConversationHistoryResourceReader = vi.fn(async (input: AgentSessionHistoryResourceRequest) => ({
    source: input.source, recordId: input.recordId, ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    partIndex: input.partIndex, reference: input.expectedReference,
    result: { status: 'read' as const, mimeType: 'image/png' as const, dataBase64: png, byteLength: 70 }
  }))
  await act(async () => root.render(<ClientUiProvider platform={platform}>
    <ConversationMessage compact content={[{ kind: 'text', text: 'Original surrounding context' },
      { kind: 'resource', resourceType: 'image', reference }]} nativeResourceRecord={record} readHistoryResource={read} />
  </ClientUiProvider>))
  expect(read).toHaveBeenCalledExactlyOnceWith({ ...record, partIndex: 1, expectedReference: reference })
  expect(container.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${png}`)
  expect(container.textContent).toContain('Original surrounding context')
})
