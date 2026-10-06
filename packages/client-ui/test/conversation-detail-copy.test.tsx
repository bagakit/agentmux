import { createHash } from 'node:crypto'
import { act, useLayoutEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryContentPart } from '@agentmux/core'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationReasoningTrace } from '../src/components/ConversationReasoningTrace.js'
import { ConversationToolTrace } from '../src/components/ConversationToolTrace.js'
import { ConversationResourceText } from '../src/components/ConversationResourceText.js'
import { ConversationMessage } from '../src/components/ConversationMessage.js'
import type { ConversationHistoryResourceReader } from '../src/components/ConversationResourceImage.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root, platform: ClientUiPlatform
const copyText = vi.fn<ClientUiPlatform['copyText']>()
beforeEach(() => {
  copyText.mockReset(); copyText.mockResolvedValue(true)
  platform = { copyText, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
    renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render(content: ReactNode, adapter: ClientUiPlatform | null = platform) {
  await act(async () => root.render(adapter ? <ClientUiProvider platform={adapter}>{content}</ClientUiProvider> : content))
}
const button = (label = 'Copy reasoning') => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
const status = (label?: string) => button(label)?.querySelector('[role="status"]')?.textContent
async function click(label?: string) { expect(button(label)).not.toBeNull(); await act(async () => { button(label).focus(); button(label).click() }) }
function pending() {
  const attempts: { text: string; error(error: unknown): void; resolve(value: boolean): void }[] = []
  copyText.mockImplementation((text, error) => new Promise<boolean>(resolve => attempts.push({ text, error, resolve })))
  return attempts
}
function retained(label?: string) {
  const node = button(label), key = Object.keys(node).find(key => key.startsWith('__reactProps$'))!
  return (node as unknown as Record<string, { onClick(): void }>)[key]!.onClick
}
const reasoning = { kind: 'reasoning', text: '\n  **literal** <tag>\n\tend\n' } as const
function resource() {
  const bytes = Buffer.from(JSON.stringify(reasoning)), digest = createHash('sha256').update(bytes).digest('hex')
  const part = { kind: 'resource', resourceType: 'text', reference: 'recorded:reasoning',
    content: { encoding: 'json-utf8', kind: 'reasoning', byteLength: bytes.length, sha256: digest } } as const
  const read: ConversationHistoryResourceReader = vi.fn(async input => ({ source: input.source, recordId: input.recordId, turnId: input.turnId,
    partIndex: input.partIndex, reference: input.expectedReference, result: { status: 'fragment', encoding: 'json-utf8', dataBase64: bytes.toString('base64'),
      byteLength: bytes.length, offsetBytes: 0, totalBytes: bytes.length, sha256: digest, nextOffsetBytes: null } }))
  return { part, read }
}

it('copies each original part through the actual message consumer, preserving order and disclosure', async () => {
  const input = '\n  {"pattern":"<tag>"}\n', output = '\ttool failed\n\n'
  const parts: AgentSessionHistoryContentPart[] = [reasoning, { kind: 'tool-result', callId: 'unpaired', output, failed: true },
    { kind: 'tool-call', callId: 'another', name: 'search', input }]
  await render(<ConversationMessage messageId="message" speaker={{ role: 'agent', id: 'agent' }} name="Assistant" status="complete" content={parts} />)
  expect(host.querySelector('.content-copy')).toBeNull()
  await act(async () => {
    const details = host.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle'))
    host.querySelectorAll<HTMLButtonElement>('.conversation-tool-trace__row').forEach(node => node.click())
  })
  const before = [...host.querySelectorAll('[data-trace-kind]')].map(node => node.getAttribute('data-trace-kind'))
  for (const [label, text] of [['Copy reasoning', reasoning.text], ['Copy tool output', output], ['Copy tool input', input]]) {
    await click(label); expect(copyText.mock.calls.at(-1)).toEqual([text, expect.any(Function)]); expect(status(label)).toBe('Copied')
  }
  expect(before).toEqual(['reasoning', 'tool-result', 'tool-call'])
  expect([...host.querySelectorAll('[data-trace-kind]')].map(node => node.getAttribute('data-trace-kind'))).toEqual(before)
  expect(host.querySelector('details')!.open).toBe(true)
  expect([...host.querySelectorAll('.conversation-tool-trace__row')].every(node => node.getAttribute('aria-expanded') === 'true')).toBe(true)
  expect(host.querySelector('.conversation-tool-trace[data-status="failed"]')).not.toBeNull()
})

it('preserves original reading nodes, selection and button focus while copying', async () => {
  await render(<ConversationReasoningTrace part={reasoning} expanded />)
  const body = host.querySelector('strong')!, range = document.createRange(); range.selectNodeContents(body); window.getSelection()!.addRange(range)
  await click()
  expect(copyText).toHaveBeenCalledExactlyOnceWith(reasoning.text, expect.any(Function))
  expect(host.querySelector('strong')).toBe(body); expect(window.getSelection()!.toString()).toBe('literal')
  expect(document.activeElement).toBe(button())
})

it('does not expose a copy action for redacted, empty, collapsed or standalone details', async () => {
  for (const part of [{ ...reasoning, redacted: true }, { ...reasoning, text: '' }]) {
    await render(<ConversationReasoningTrace part={part} expanded />); expect(button()).toBeNull()
  }
  await render(<ConversationReasoningTrace part={reasoning} />); expect(button()).toBeNull()
  await render(<ConversationToolTrace part={{ kind: 'tool-call', name: 'tool', input: '' }} expanded />); expect(button('Copy tool input')).toBeNull()
  await render(<ConversationToolTrace part={{ kind: 'tool-result', output: '' }} expanded />); expect(button('Copy tool output')).toBeNull()
  await render(<ConversationReasoningTrace part={reasoning} expanded />, null); expect(button()).toBeNull()
  expect(copyText).not.toHaveBeenCalled()
})

it('copies whitespace-only original tool output without inventing an empty-content rule', async () => {
  await render(<ConversationToolTrace part={{ kind: 'tool-result', output: '\n \t' }} expanded />)
  await click('Copy tool output'); expect(copyText).toHaveBeenCalledExactlyOnceWith('\n \t', expect.any(Function))
})

it('does not copy twice while pending and releases failure for retry without accepting an obsolete attempt', async () => {
  const attempts = pending(); await render(<ConversationReasoningTrace part={reasoning} expanded />)
  await act(async () => { button().focus(); button().click(); button().click() })
  expect(attempts).toHaveLength(1); expect(status()).toBe('Copying…'); expect(document.activeElement).toBe(button())
  await act(async () => attempts[0]!.error(new Error('Clipboard refused'))); expect(status()).toBe('Retry copy')
  await click(); expect(attempts).toHaveLength(2)
  await act(async () => attempts[0]!.resolve(true)); expect(status()).toBe('Copying…')
  await act(async () => attempts[1]!.resolve(true)); expect(status()).toBe('Copied')
  await act(async () => attempts[0]!.error(new Error('Old failure'))); expect(status()).toBe('Copied')
})

it('requires a strict successful receipt and lets reported failure take precedence', async () => {
  copyText.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined as unknown as boolean)
    .mockRejectedValueOnce(new Error('Clipboard unavailable')).mockImplementationOnce(async (_text, error) => { error('Denied'); return true })
  await render(<ConversationReasoningTrace part={reasoning} expanded />)
  for (let index = 0; index < 4; index++) { await click(); expect(status()).toBe('Retry copy') }
  await click(); expect(status()).toBe('Copied')
})

it('resets feedback on the first presentation of another record even with identical text, including A-B-A', async () => {
  const attempts = pending(), firstFrames: string[] = []
  function Observed({ id }: { id: string }) {
    useLayoutEffect(() => { firstFrames.push(status() ?? '') }, [id])
    return <ConversationReasoningTrace part={reasoning} traceId={id} expanded />
  }
  await render(<Observed id="A" />); await click(); const obsolete = retained()
  await render(<Observed id="B" />); expect(firstFrames.at(-1)).toBe('Copy')
  await act(async () => obsolete()); expect(attempts).toHaveLength(1)
  await render(<Observed id="A" />); expect(status()).toBe('Copy'); await click()
  await act(async () => attempts[1]!.resolve(true)); expect(status()).toBe('Copied')
  await act(async () => { attempts[0]!.resolve(true); attempts[0]!.error('Old A') }); expect(status()).toBe('Copied')
})

it('isolates input/output and newly read parts sharing one call ID', async () => {
  const attempts = pending(), part = { kind: 'tool-call', callId: 'same-call', name: 'tool', input: 'same' } as const
  await render(<ConversationToolTrace part={part} traceId="record" expanded />); await click('Copy tool input')
  await render(<ConversationToolTrace part={{ kind: 'tool-result', callId: 'same-call', output: 'same' }} traceId="record" expanded />)
  expect(status('Copy tool output')).toBe('Copy'); await click('Copy tool output')
  await act(async () => attempts[1]!.resolve(true)); await act(async () => attempts[0]!.resolve(false))
  expect(status('Copy tool output')).toBe('Copied')
  await render(<ConversationToolTrace part={{ ...part }} traceId="record" expanded />); expect(status('Copy tool input')).toBe('Copy')
})

it('rejects retained handlers and feedback after collapse or unmount', async () => {
  const attempts = pending(); await render(<ConversationReasoningTrace part={reasoning} expanded />); await click(); const obsolete = retained()
  await render(<ConversationReasoningTrace part={reasoning} expanded={false} />)
  await act(async () => { obsolete(); attempts[0]!.resolve(true); attempts[0]!.error('Collapsed') }); expect(attempts).toHaveLength(1)
  await render(<ConversationReasoningTrace part={reasoning} expanded />); expect(status()).toBe('Copy')
})

it('removes loaded content on the first frame of a new resource source and discards the old copy receipt', async () => {
  const { part, read } = resource()
  const firstFrames: boolean[] = [], attempts = pending()
  function Observed({ source }: { source: string }) {
    useLayoutEffect(() => { firstFrames.push(host.querySelector('[data-trace-kind]') !== null) }, [source])
    return <ConversationResourceText part={part} partIndex={2} record={{ source: { providerId: 'codex', nativeSessionId: source }, recordId: 'record', turnId: 'turn' }} readResource={read} />
  }
  async function load() {
    await act(async () => host.querySelector<HTMLButtonElement>('.conversation-resource-text__controls button')!.click())
    await act(async () => { const details = host.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
  }
  await render(<Observed source="A" />); await load(); await click(); const obsolete = retained()
  await render(<Observed source="B" />); expect(firstFrames.at(-1)).toBe(false); expect(button()).toBeNull()
  await act(async () => obsolete()); expect(attempts).toHaveLength(1)
  await load(); expect(status()).toBe('Copy'); await click()
  await act(async () => attempts[1]!.resolve(true)); await act(async () => { attempts[0]!.resolve(false); attempts[0]!.error('Old source') })
  expect(status()).toBe('Copied'); expect(read).toHaveBeenCalledTimes(2)
})

it.each(['loading', 'failed'])('does not project the %s state of a previous source on the first new frame', async state => {
  const { part, read: successful } = resource()
  const read: ConversationHistoryResourceReader = vi.fn(input => input.source.nativeSessionId === 'A' ?
    state === 'loading' ? new Promise(() => {}) : Promise.reject(new Error('Only source A failed')) : successful(input))
  const frames: { disabled: boolean; text: string; error: string | null }[] = []
  function Observed({ source }: { source: string }) {
    useLayoutEffect(() => {
      const node = host.querySelector<HTMLButtonElement>('.conversation-resource-text__controls button')!
      frames.push({ disabled: node.disabled, text: node.textContent ?? '', error: host.querySelector('[role="alert"]')?.textContent ?? null })
    }, [source])
    return <ConversationResourceText part={part} partIndex={0} record={{ source: { providerId: 'codex', nativeSessionId: source }, recordId: 'record' }} readResource={read} />
  }
  await render(<Observed source="A" />)
  await act(async () => host.querySelector<HTMLButtonElement>('.conversation-resource-text__controls button')!.click())
  expect(host.textContent).toContain(state === 'loading' ? 'Reading complete content' : 'Only source A failed')
  await render(<Observed source="B" />)
  expect(frames.at(-1)).toEqual({ disabled: false, text: expect.stringContaining('Read complete content'), error: null })
})

it('keeps old close and read handlers from acting on another resource or an unmounted view', async () => {
  const { part, read } = resource()
  const draw = (source: string) => <ConversationResourceText part={part} partIndex={0} record={{ source: { providerId: 'codex', nativeSessionId: source }, recordId: 'record' }} readResource={read} />
  function handler(node: HTMLButtonElement) {
    const key = Object.keys(node).find(key => key.startsWith('__reactProps$'))!
    return (node as unknown as Record<string, { onClick(): void }>)[key]!.onClick
  }
  await render(draw('A')); const oldRead = handler(host.querySelector('button')!)
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  const oldClose = handler([...host.querySelectorAll('button')].find(node => node.textContent === 'Close content')!)
  await render(draw('B')); await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  await act(async () => { oldRead(); oldClose() })
  expect(host.querySelector('details')).not.toBeNull(); expect(read).toHaveBeenCalledTimes(2)
  const unmountedRead = handler([...host.querySelectorAll('button')].find(node => node.textContent === 'Close content')!)
  await render(null); await act(async () => { oldRead(); unmountedRead() })
  expect(read).toHaveBeenCalledTimes(2)
})
