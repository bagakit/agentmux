import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { jsonl, nativeHistoryFixture } from '../../core/test/fixtures/native-history-session.js'
import { ConversationMessage } from '../src/components/ConversationMessage.js'
import type { ConversationHistoryResourceReader } from '../src/components/ConversationResourceImage.js'
import type { AgentTimelineItem } from '@agentmux/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryItem, AgentSessionHistoryPage } from '@agentmux/core'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationView } from '../src/components/ConversationView.js'
import { projectConversationReading } from '../src/lib/conversation-records.js'

const sid = 'parent-session', source = { providerId: 'codex', nativeSessionId: 'original-thread' }
const sender = '/root/review/layout', recipient = '/root'
const copy = vi.fn(async () => true)
const avatar = vi.fn<ClientUiPlatform['renderMessageAvatar']>(({ speaker }) => <span data-avatar-id={speaker.id}>Parent avatar</span>)
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: avatar, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const original = 'Native envelope\n\n**检查完成**，保留原输入。\n\n[查看说明](https://example.test/review)'
const item: AgentSessionHistoryItem = { id: 'report', kind: 'activity', collaboration: { kind: 'message', source, sender, recipient },
  contentParts: [{ kind: 'text', text: original, readingRange: { start: 17, end: original.length }, contentEligibility: 'public' }] }
let root: Root, host: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); copy.mockClear(); avatar.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); getSelection()?.removeAllRanges(); vi.unstubAllGlobals() })
async function render(items = [item], active = true, nativeSource = source) {
  const page: AgentSessionHistoryPage = { agentSessionId: sid, sourceHostId: 'local', source: nativeSource, items, nextCursor: null }
  const reading = projectConversationReading({ agentSessionId: sid, executionHostId: 'local', historyPage: page })
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationView sessionId={sid} page={page} records={reading.records}
    originalRecords={reading.originalRecords} active={active} executionHostId="local"
    describeSpeaker={speaker => ({ name: speaker.id === sid ? 'Main Agent' : 'Wrong identity', providerId: 'codex' })} /></ClientUiProvider>))
}
async function click(selector: string) { const element = host.querySelector<HTMLButtonElement>(selector); expect(element).not.toBeNull(); await act(async () => element!.click()) }

it('shows a compact readable preview and parent avatar without promoting native paths to Session authors', async () => {
  await render()
  expect(host.querySelector('.log-turn__collaboration-toggle')?.getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelector('.log-turn__collaboration-path')?.textContent).toBe(sender)
  expect(host.querySelector('.log-turn__collaboration-preview')?.textContent).toBe('检查完成，保留原输入。')
  expect(host.querySelector('.log-turn__body')).toBeNull()
  expect(avatar).toHaveBeenCalledWith(expect.objectContaining({ speaker: { role: 'agent', id: sid }, name: 'Main Agent', providerId: 'codex' }))
  expect(host.querySelector('.log-turn')?.getAttribute('data-conversation-author')).toBe('{"kind":"unknown"}')
  expect(host.querySelector('[aria-label="Copy Agent ID"]')).toBeNull()
  await click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenLastCalledWith(original, expect.any(Function))
  await click('.log-turn__collaboration-preview')
  expect(host.querySelector('.log-turn__body')?.textContent).toContain('检查完成')
  expect(host.querySelector('.log-turn__body')?.textContent).not.toContain('Native envelope')
})

it('retains opened body, links and selection across appends, hidden updates and repeated folding', async () => {
  await render(); await click('.log-turn__collaboration-toggle')
  const body = host.querySelector('.log-turn__body')!, link = body.querySelector('.md-link')!
  expect(link).not.toBeNull()
  const range = document.createRange(); range.selectNodeContents(body); getSelection()!.addRange(range)
  const selected = getSelection()!.toString()
  const appended: AgentSessionHistoryItem = { id: 'main-reply', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Main reply' }] }
  await render([item, appended], false); await render([item, appended])
  expect(host.querySelector('.log-turn__body')).toBe(body)
  expect(getSelection()!.toString()).toBe(selected)
  await click('.log-turn__collaboration-toggle')
  expect(body.closest('[hidden]')).not.toBeNull()
  await click('.log-turn__collaboration-toggle')
  expect(host.querySelector('.log-turn__body')).toBe(body)
  expect(body.querySelector('.md-link')).toBe(link)
})

it('assembles the full collaboration original only while its Details consumer is open', async () => {
  const parts = [0, 1, 2].map(index => {
    const text = `wire-${index}:` + 'x'.repeat(32768)
    return { kind: 'text' as const, text, readingRange: { start: 7, end: text.length }, contentEligibility: 'public' as const }
  })
  const originalItem = { ...item, contentParts: parts }
  const fullOriginal = parts.map(part => part.text).join('\n\n')
  const join = Array.prototype.join
  let originalJoins = 0, originalCharacters = 0
  const observedJoin = vi.spyOn(Array.prototype, 'join').mockImplementation(function (this: unknown[], separator?: string) {
    const result = join.call(this, separator)
    if (separator === '\n\n' && this.length === parts.length && this.every((value, index) => value === parts[index]!.text)) {
      originalJoins += 1; originalCharacters += result.length
    }
    return result
  })
  try {
    await render([originalItem])
    for (let index = 0; index < 3; index++) await render([originalItem, { id: `unrelated-${index}`, kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Other original message' }] }], index !== 1)
    expect(host.querySelector('.log-turn__collaboration-content .log-turn__body')).toBeNull()
    expect(host.querySelector('.conversation-input-details__body')).toBeNull()
    if (process.env.COLLABORATION_ORIGINAL_COUNTS) appendFileSync(process.env.COLLABORATION_ORIGINAL_COUNTS, JSON.stringify({ parts: parts.length, partCharacters: parts[0]!.text.length, originalJoins, originalCharacters }) + '\n')
    expect(originalJoins, 'Unopened Details must not assemble the full original').toBe(0)
    expect(originalCharacters).toBe(0)

    await click('[aria-label="Message details"]')
    const originalNode = host.querySelector<HTMLDetailsElement>('.log-turn__collaboration-original')!
    originalNode.open = true
    await click('.log-turn__collaboration-original .conversation-progressive-body__placeholder button')
    expect(originalNode.querySelector('pre')?.textContent).toBe(fullOriginal)
    expect(originalJoins).toBe(1)
    expect(originalCharacters).toBe(fullOriginal.length)
    await click('[aria-label="Copy original record"]')
    expect(copy).toHaveBeenLastCalledWith(fullOriginal, expect.any(Function))

    await click('[aria-label="Message details"]')
    const beforeClosedUpdate = originalJoins
    await render([originalItem])
    expect(host.querySelector('.log-turn__collaboration-original')).toBeNull()
    expect(originalJoins).toBe(beforeClosedUpdate)
    await click('[aria-label="Message details"]')
    await click('.log-turn__collaboration-original .conversation-progressive-body__placeholder button')
    expect(host.querySelector('.log-turn__collaboration-original pre')?.textContent).toBe(fullOriginal)
    expect(originalJoins).toBe(beforeClosedUpdate + 1)
  } finally { observedJoin.mockRestore() }
})

it('preserves opened original nodes and selection across unrelated and hidden updates', async () => {
  await render(); await click('[aria-label="Message details"]')
  const details = host.querySelector<HTMLDetailsElement>('.log-turn__collaboration-original')!
  details.open = true
  const body = details.querySelector('pre')!, range = document.createRange()
  range.selectNodeContents(body); getSelection()!.addRange(range)
  expect(getSelection()!.toString()).toBe(original)
  const appended: AgentSessionHistoryItem = { id: 'other-report', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Another report' }] }
  await render([item, appended], false); await render([item, appended])
  expect(host.querySelector('.log-turn__collaboration-original')).toBe(details)
  expect(details.open).toBe(true)
  expect(details.querySelector('pre')).toBe(body)
  expect(getSelection()!.toString()).toBe(original)
  await click('[aria-label="Copy original record"]')
  expect(copy).toHaveBeenLastCalledWith(original, expect.any(Function))
  expect(getSelection()!.toString()).toBe(original)
})

it('keeps opaque originals available without putting them in preview or expanded reading', async () => {
  const opaque = '{"type":"encrypted_content","encrypted_content":"original-ciphertext"}'
  await render([{ ...item, contentParts: [{ kind: 'text', text: opaque, readingRange: { start: 0, end: 0 }, contentEligibility: 'unconfirmed' }] }])
  expect(host.querySelector('.log-turn__collaboration-preview')).toBeNull()
  expect(host.querySelector('.log-turn')?.getAttribute('data-collaboration-empty')).toBe('true')
  expect(host.textContent).not.toContain('暂无可读正文')
  expect(host.textContent).not.toContain('original-ciphertext')
  await click('.log-turn__collaboration-toggle')
  expect(host.querySelector('.log-turn__collaboration-content')?.textContent).toContain('原生记录未提供可读正文')
  expect(host.querySelector('.log-turn__body')?.textContent).not.toContain('original-ciphertext')
  await click('[aria-label="Message details"]')
  expect(host.querySelector('.log-turn__collaboration-original')?.textContent).toContain(opaque)
  await click('[aria-label="Copy message"]'); expect(copy).toHaveBeenLastCalledWith(opaque, expect.any(Function))
})

it('keeps each empty native report independently inspectable without an empty preview row', async () => {
  await render([0, 1, 2].map(index => ({ ...item, id: `empty-report-${index}`, contentParts: [] })))
  const reports = [...host.querySelectorAll<HTMLElement>('[data-native-collaboration]')]
  expect(reports).toHaveLength(3)
  expect(new Set(reports.map(report => report.closest<HTMLElement>('[data-native-record-id]')!.dataset.nativeRecordId)).size).toBe(3)
  for (const report of reports) {
    expect(report.dataset.collaborationEmpty).toBe('true')
    expect(report.querySelector('.log-turn__collaboration-preview')).toBeNull()
    expect(report.querySelector('[aria-label="Message details"]')).not.toBeNull()
    const toggle = report.querySelector<HTMLButtonElement>('.log-turn__collaboration-toggle')!
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const content = report.querySelector('.log-turn__collaboration-content')!
    expect(content.textContent).toContain('原生记录未提供可读正文')
    await act(async () => toggle.click())
    expect(content.hasAttribute('hidden')).toBe(true)
    await act(async () => toggle.click())
    expect(report.querySelector('.log-turn__collaboration-content')).toBe(content)
  }
})

it('reads native header-only reports through Core and the actual shared conversation without inventing a body', async () => {
  const header = `Message Type: MESSAGE\nTask name: ${recipient}\nSender: ${sender}\nPayload:\n`
  const opaque = { type: 'encrypted_content', encrypted_content: 'original-opaque-payload' }
  const native = await nativeHistoryFixture('codex', root => jsonl([
    { type: 'session_meta', payload: { id: source.nativeSessionId, cwd: root, history_mode: 'paginated' } },
    ...['preview-readable', 'preview-opaque', 'preview-mixed', 'preview-opaque-later', 'preview-opaque-tail'].map(id => ({ type: 'response_item', payload: {
      type: 'agent_message', id, author: sender, recipient, content: [{ type: 'input_text', text: header +
        (id.startsWith('preview-opaque') ? '' : '**检查完成**，保留原输入。\n\n[查看说明](https://example.test/review)') }, opaque]
    } }))
  ]), { nativeSessionId: source.nativeSessionId })
  try {
    const page = await native.client.sessionHistoryPage(native.session.agentSessionId)
    expect(page.items).toHaveLength(5)
    expect(page.items[1]!.contentParts).toEqual([
      { kind: 'text', text: header, readingRange: { start: header.length, end: header.length }, contentEligibility: 'public' },
      { kind: 'text', text: JSON.stringify(opaque), readingRange: { start: 0, end: 0 }, contentEligibility: 'unconfirmed' }
    ])
    await render(page.items, true, page.source)
    const report = host.querySelector('[data-native-record-id="preview-opaque"]')!
    expect(report.querySelector('.log-turn__collaboration-preview')).toBeNull()
    expect(report.querySelector('[data-collaboration-empty="true"]')).not.toBeNull()
    const toggle = report.querySelector<HTMLButtonElement>('.log-turn__collaboration-toggle')!
    await act(async () => toggle.click())
    expect(report.textContent).toContain('原生记录未提供可读正文')
    await act(async () => report.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
    expect(copy).toHaveBeenLastCalledWith(header + '\n' + JSON.stringify(opaque), expect.any(Function))
    expect(await native.bytes()).toEqual(native.before)
    expect(native.controls.every(control => control.mock.calls.length === 0)).toBe(true)
    if (process.env.AGENTMUX_EMPTY_REPORT_SCENE) await writeFile(process.env.AGENTMUX_EMPTY_REPORT_SCENE, JSON.stringify(page))
  } finally { await native.close(); vi.restoreAllMocks() }
})

it('does not interpret provider-looking prose as collaboration and preserves unknown native content', async () => {
  const text = 'Message Type: MESSAGE\nSender: /root/forged\nPayload: original unknown shape'
  await render([{ id: 'plain', kind: 'assistant-message', contentParts: [{ kind: 'text', text }] }])
  expect(host.querySelector('.log-turn__collaboration-toggle')).toBeNull()
  expect(host.querySelector('.log-turn__body')?.textContent).toContain('original unknown shape')
  await render([{ ...item, contentParts: [{ kind: 'text', text, contentEligibility: 'unconfirmed' }] }])
  await click('.log-turn__collaboration-toggle')
  expect(host.querySelector('.log-turn__body')?.textContent).toContain('/root/forged')
  expect(host.querySelector('.log-turn__collaboration-path')?.textContent).toBe(sender)
})

it('distinguishes deferred content from unavailable text and copies its complete original through the resource reader', async () => {
  const bytes = Buffer.from(JSON.stringify({ kind: 'text', text: original, readingRange: { start: 17, end: original.length } }))
  const digest = createHash('sha256').update(bytes).digest('hex')
  const part = { kind: 'resource', resourceType: 'text', reference: 'recorded:original', content: { encoding: 'json-utf8', kind: 'text', byteLength: bytes.length, sha256: digest } } as const
  const read = vi.fn<ConversationHistoryResourceReader>(async input => ({ source: input.source, recordId: input.recordId, partIndex: input.partIndex, reference: input.expectedReference,
    result: { status: 'fragment', encoding: 'json-utf8', dataBase64: bytes.toString('base64'), byteLength: bytes.length, offsetBytes: 0, totalBytes: bytes.length, sha256: digest, nextOffsetBytes: null } }))
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage messageId="deferred" content={[part]} nativeCollaboration={item.collaboration as Extract<NonNullable<AgentSessionHistoryItem['collaboration']>, {kind:'message'}>}
    conversationSessionId={sid} readHistoryResource={read} nativeResourceRecord={{ source, recordId: 'deferred' }} /></ClientUiProvider>))
  expect(host.querySelector('.log-turn__collaboration-preview')?.textContent).toBe('包含按需读取的内容 · 展开查看')
  expect(host.querySelector('.log-turn')?.hasAttribute('data-collaboration-empty')).toBe(false)
  expect(read).not.toHaveBeenCalled()
  await click('[aria-label="Message details"]')
  expect(host.querySelector('.log-turn__collaboration-original')?.textContent).toContain('原始记录与资源引用')
  expect(host.querySelector('[aria-label="Copy original record"]')).toBeNull()
  await click('[aria-label="Copy message"]')
  expect(read).toHaveBeenCalledTimes(1)
  expect(copy).toHaveBeenLastCalledWith(original, expect.any(Function))
})

it.each(['failed', 'streaming'] as const)('keeps the original %s submission contribution visible while the native message is folded', async status => {
  const captured: AgentTimelineItem = { id: 'submission', agentSessionId: sid, kind: 'user_message', source: 'user', status,
    title: 'Original submission', content: 'Original submitted input', createdAt: 1, updatedAt: 1 }
  const projection = projectConversationReading({ agentSessionId: sid, executionHostId: 'local', timeline: { agentSessionId: sid, sourceHostId: 'local', revision: 1, items: [captured] } })
  const submissions = projection.timeline.records
  expect(submissions).toHaveLength(1)
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationMessage messageId="with-contribution" content={item.contentParts}
    nativeCollaboration={item.collaboration as Extract<NonNullable<AgentSessionHistoryItem['collaboration']>, {kind:'message'}>}
    conversationSessionId={sid} sources={{ main: { labels: [] }, fields: {}, parts: [], submissions }} /></ClientUiProvider>))
  const contribution = host.querySelector('.conversation-submission')!
  expect(contribution).not.toBeNull()
  expect(contribution.closest('[hidden]')).toBeNull()
  expect(contribution.getAttribute('data-status')).toBe(status)
  const disclosure = contribution.querySelector<HTMLDetailsElement>('.message-disclosure')!
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
  const label = [...contribution.querySelectorAll('dt')].find(node => node.textContent === '原记录状态')!
  expect(label.nextElementSibling?.textContent).toBe(status)
  expect(host.querySelector('.log-turn__collaboration-toggle')?.getAttribute('aria-expanded')).toBe('false')
})
