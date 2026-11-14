// @vitest-environment happy-dom
import './device-locks'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { MobileMoteComposer, MobileComposerSource, mobileMoteStartDraftKey, mobileMoteTextScope, mobileWelcomeComposerSource } from '../src/conversation/mote-composer'
import { MobileLocalDraftsOwner } from '../src/conversation/local-drafts-owner'
import { createMoteConversationStartFixture } from '../../host/test/helpers/mote-conversation-start-fixture'
import { fixture, mount, mounted, paste, editor, deferred, button, click, acceptedPrompt } from './conversation-fixture'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { Blob as NodeBlob } from 'node:buffer'
import { nativeDevicePorts, type NativeDevicePorts } from '../src/platform/native/device'

const closing: Array<() => Promise<unknown>> = []
const originalPicker = nativeDevicePorts.filePicker
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  for (const close of closing.splice(0).reverse()) await close()
  document.body.replaceChildren(); nativeDevicePorts.filePicker = originalPicker; vi.restoreAllMocks()
})
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 12_000, interval: 20 }) }
async function actualMote({ delayed = false, draft = 'Alpha omega', sessionDraft = 'Original Session B draft', initialRuntime = 'continuity-runtime' as string | null,
  providerId = 'claude' as 'claude' | 'codex', savedManual = false } = {}) {
  const host = await createMoteConversationStartFixture({ providerId }); closing.push(host.close)
  // Existing exact Main, without manufacturing a delivered first Query.
  await host.start('existing-main'); const setup = await host.setup('existing-main')
  expect(setup.binding, setup.issue ?? '').toBe('confirmed')
  const ref = setup.reference!, session = (await host.h.client.readAgentSession(ref.sessionId))!
  const f = fixture(), owner = getDeviceWorkface(); f.sessions.set(ref.sessionId, session)
  let runtimeId = initialRuntime
  f.client.runtimeOwnerIdentity = () => ({ runtimeId, ownerInstanceId: 'continuity-owner', availability: 'connected' }) as ReturnType<AgentMuxHostedClient['runtimeOwnerIdentity']>
  await owner.confirmHost({ origin: location.origin, hostId: 'local' })
  const identity = { name: 'Original Mote', project: 'Original', mote: { spaceId: host.target.spaceId, name: 'Original Mote',
    contentReference: { ...host.target.expectedResource, zoneId: host.target.zoneId } } }
  await owner.updatePresentation({ selectedSessionId: ref.sessionId, hostUrl: '', panel: 'conversation' }, { primary: 'mote', showSession: true,
    showGoalWork: false, recentMoteSpaceId: host.target.spaceId, identity, profile: null,
    moteView: { spaceId: host.target.spaceId, section: 'discussion', detail: false, directAgent: false } })
  const key = mobileMoteStartDraftKey(f.client, host.target), sessionKey = JSON.stringify(['draft', ref.sessionId])
  await owner.editConversation([{ bucket: 'drafts', key, next: draft }, { bucket: 'drafts', key: sessionKey, next: sessionDraft }], owner.recordIdentity())
  if (savedManual) {
    const main = await host.main.readCurrentMoteMain(host.target)
    await owner.editConversation([{ bucket: 'attempts', key: sessionKey, next: { operationId: 'original-saved-manual', runId: session.run.runId,
      draft: 'Original saved manual body', phase: 'unknown', explicit: true, inputRequested: false,
      originalHostId: 'local', originalRuntimeId: runtimeId,
      manualInput: { agentSessionId: ref.sessionId, expectedRun: session.run, runtimeId },
      moteMain: { target: host.target, identity: main.identity!, expectedRoleRevision: main.roleRevision!, reference: ref } } }], owner.recordIdentity())
  }
  const gate = deferred<void>(); if (!delayed) gate.resolve(); closing.push(async () => gate.resolve())
  let inputReply: ReturnType<typeof deferred<void>> | null = null
  const rpc = vi.fn(async (method: any, input: any) => {
    if (method === 'space.mote.dialogue.read' || method === 'space.ls') await gate.promise
    const result = await host.rpc.call(method, input)
    if (method === 'space.mote.dialogue.input.submit' && inputReply) await inputReply.promise
    return result
  })
  f.client.forwardRpc = rpc as AgentMuxHostedClient['forwardRpc']
  f.client.readAgentConversation = host.h.client.readAgentConversation.bind(host.h.client)
  f.client.readConversationChanges = host.h.client.readConversationChanges.bind(host.h.client)
  f.client.observeConversation = host.h.client.observeConversation.bind(host.h.client)
  f.client.releaseConversationView = host.h.client.releaseConversationView.bind(host.h.client)
  const render = () => <MobileApp client={f.client} connection={{ state: 'connected', message: 'Original Host' }} platform={createBrowserPlatform()} restoreWorkface />
  const view = await mount(render()), panel = () => view.element.querySelector<HTMLElement>('.mobile-conversation-panel')!
  await wait(() => expect(panel().querySelector('.mobile-mote-composer [contenteditable="true"]')).toBeTruthy())
  return { host, f, owner, ref, session, key, sessionKey, view, panel, rpc, gate, render, changeRuntime: (value: string) => { runtimeId = value },
    holdInput() { inputReply = deferred<void>(); closing.push(async () => inputReply!.resolve()); return inputReply } }
}
function selectText(node: HTMLElement, from: number, to = from) {
  node.focus()
  const text = node.querySelector('p')!.firstChild!, range = document.createRange()
  range.setStart(text, from); range.setEnd(text, to)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}
async function replaceText(panel: HTMLElement, text: string) {
  const node = editor(panel)
  await act(async () => selectText(node, 0, node.textContent!.length))
  await paste(panel, text)
}

it('actual Mobile Mote continuity keeps one editor, mid-text selection and IME through late original Main facts', async () => {
  const f = await actualMote({ delayed: true }), original = editor(f.panel())
  await act(async () => { selectText(original, 2, 7); original.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
  const selected = window.getSelection()!.toString()
  await act(async () => f.gate.resolve())
  await wait(() => expect(f.panel().querySelector('.composer__editor')?.getAttribute('data-placeholder')).toBe('发消息'))
  expect(editor(f.panel())).toBe(original); expect(window.getSelection()!.toString()).toBe(selected)
  expect(document.activeElement).toBe(original)
  expect(original.textContent).toBe('Alpha omega')
  await act(async () => original.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', isComposing: true })))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(0)
  await act(async () => { original.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); selectText(original, 5) })
  await paste(f.panel(), ' middle')
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Alpha middle omega'))
  await act(async () => original.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', ctrlKey: true })))
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Alpha omega'))
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.sessionKey)).toBe('Original Session B draft')
  expect(editor(f.panel())).toBe(original); expect(f.host.h.started).toHaveLength(1); expect(f.host.h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('actual Mobile Mote continuity does not replace text when the original Runtime identity first becomes known', async () => {
  const f = await actualMote({ delayed: true, initialRuntime: null }), original = editor(f.panel())
  await act(async () => selectText(original, 5)); await paste(f.panel(), ' partial')
  const body = original.textContent
  f.changeRuntime('continuity-runtime'); await f.view.render(f.render()); await act(async () => f.gate.resolve())
  expect(editor(f.panel())).toBe(original); expect(original.textContent).toBe(body)
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Alpha partial omega'))
  const observedKey = mobileMoteStartDraftKey(f.f.client, f.host.target)
  expect(observedKey).not.toBe(f.key)
  expect(new Map(f.owner.snapshot().record.conversation.drafts).has(observedKey)).toBe(false)
})

it('actual Mobile Mote continuity restores first-frame text after Runtime becomes known and the whole page reopens', async () => {
  const f = await actualMote({ delayed: true, initialRuntime: null, draft: '' })
  expect(f.owner.snapshot().record.conversation.moteTextSources ?? []).toEqual([])
  const save = vi.spyOn(f.owner, 'editConversation')
  await paste(f.panel(), 'Original first-frame A')
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Original first-frame A'))
  expect(save.mock.calls.some(([edits]) => edits.some(edit => edit.bucket === 'drafts' && edit.key === f.key && edit.next === 'Original first-frame A') &&
    edits.some(edit => edit.bucket === 'moteTextSources' && edit.key === mobileMoteTextScope(f.host.target) && edit.next === f.key))).toBe(true)
  f.changeRuntime('continuity-runtime'); await f.view.render(f.render()); await act(async () => f.gate.resolve())
  await wait(() => expect(f.panel().querySelector('.composer__editor')?.getAttribute('data-placeholder')).toBe('发消息'))
  await f.view.render(<div />); await f.view.render(f.render())
  await wait(() => expect(editor(f.panel()).textContent).toBe('Original first-frame A'))
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.sessionKey)).toBe('Original Session B draft')
  expect(f.host.h.started).toHaveLength(1)
})

it('actual Mobile Mote retains both original text and address conflicts in the same Device CAS transaction', async () => {
  const f = await actualMote({ delayed: true, initialRuntime: null, draft: '' }), gate = deferred<void>()
  closing.push(async () => gate.resolve())
  const originalWrite = f.owner.editConversation.bind(f.owner), scope = mobileMoteTextScope(f.host.target)
  let held = false
  vi.spyOn(f.owner, 'editConversation').mockImplementation(async (edits, recordId) => {
    if (!held && edits.some(edit => edit.bucket === 'drafts' && edit.key === f.key && edit.next === 'Original pending A')) { held = true; await gate.promise }
    return originalWrite(edits, recordId)
  })
  await paste(f.panel(), 'Original pending A'); await wait(() => expect(held).toBe(true))
  f.changeRuntime('continuity-runtime')
  const otherKey = mobileMoteStartDraftKey(f.f.client, f.host.target)
  await originalWrite([{ bucket: 'moteTextSources', key: scope, next: otherKey },
    { bucket: 'drafts', key: f.key, expected: '', next: 'Other original text' },
    { bucket: 'drafts', key: otherKey, next: 'Other address text' }], f.owner.recordIdentity())
  await act(async () => gate.resolve())
  await wait(() => expect(f.owner.snapshot().record.conversation.conflicts).toEqual(expect.arrayContaining([
    { bucket: 'drafts', key: f.key, value: 'Original pending A' }, { bucket: 'moteTextSources', key: scope, value: f.key }
  ])))
  const current = f.owner.snapshot().record.conversation
  expect(new Map(current.moteTextSources).get(scope)).toBe(otherKey)
  expect(new Map(current.drafts).get(f.key)).toBe('Other original text')
  expect(new Map(current.drafts).get(otherKey)).toBe('Other address text')
  expect(new Map(current.drafts).get(f.sessionKey)).toBe('Original Session B draft')
})

it('actual Mobile Mote continuity keeps later text when its original Device save ACK arrives last', async () => {
  const f = await actualMote({ draft: '' }), original = editor(f.panel()), gate = deferred<void>()
  closing.push(async () => gate.resolve())
  const write = f.owner.editConversation.bind(f.owner); let held = false
  vi.spyOn(f.owner, 'editConversation').mockImplementation(async (edits, recordId) => {
    const committed = await write(edits, recordId)
    if (!held && edits.some(item => item.bucket === 'drafts' && item.key === f.key && item.next === 'Original A')) { held = true; await gate.promise }
    return committed
  })
  await paste(f.panel(), 'Original A'); await wait(() => expect(held).toBe(true))
  await paste(f.panel(), ' and later C')
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Original A and later C'))
  await act(async () => gate.resolve())
  expect(editor(f.panel())).toBe(original); expect(original.textContent).toBe('Original A and later C')
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.sessionKey)).toBe('Original Session B draft')
})

it('actual Mobile Mote continuity sends its own text through the original Session ledger and a late owned receipt cannot clear later C', async () => {
  const f = await actualMote(), original = editor(f.panel()), held = f.holdInput()
  await wait(() => expect(f.panel().querySelector('.composer__editor')?.getAttribute('data-placeholder')).toBe('发消息'))
  await click(button(f.panel(), 'Send'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(1))
  const packet = f.rpc.mock.calls.find(([method]) => method === 'space.mote.dialogue.input.submit')![1]
  const inputResult = f.rpc.mock.results[f.rpc.mock.calls.findIndex(([method]) => method === 'space.mote.dialogue.input.submit')]!.value
  expect(packet.input.prompt).toBe('Alpha omega'); expect(packet.input.agentSessionId).toBe(f.ref.sessionId)
  expect(packet.input.admissionIntent).toEqual({ kind: 'session-conversation' })
  expect(new Map(f.owner.snapshot().record.conversation.attempts).get(f.sessionKey)).toMatchObject({
    operationId: packet.input.operationId, draft: 'Alpha omega', textSource: { key: f.key, recordId: f.owner.recordIdentity() }
  })
  await act(async () => selectText(original, 5)); await paste(f.panel(), ' later C')
  await act(async () => { held.resolve(); await inputResult })
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Alpha later C omega'))
  expect(editor(f.panel())).toBe(original)
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.sessionKey)).toBe('Original Session B draft')
  const observed = await f.host.rpc.call('space.mote.dialogue.input.inspect', { target: f.host.target, operationId: packet.input.operationId })
  expect(observed.route?.key).toMatchObject({ agentSessionId: f.ref.sessionId, expectedRun: f.session.run, submissionId: packet.input.operationId })
  expect(f.host.h.started).toHaveLength(1); expect(f.host.h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['mote', 'session'] as const)('actual Mobile %s preserves a later A after A to B to A edits and the original delayed receipt', async source => {
  let panel: () => HTMLElement, key: string, owner = getDeviceWorkface(), release: () => Promise<void>, operation: () => string
  if (source === 'mote') {
    const f = await actualMote(), gate = f.holdInput()
    panel = f.panel; key = f.key
    await wait(() => expect(panel().querySelector('.composer__editor')?.getAttribute('data-placeholder')).toBe('发消息'))
    await click(button(panel(), 'Send'))
    await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(1))
    const index = f.rpc.mock.calls.findIndex(([method]) => method === 'space.mote.dialogue.input.submit')
    operation = () => f.rpc.mock.calls[index]![1].input.operationId
    release = async () => { gate.resolve(); await f.rpc.mock.results[index]!.value }
  } else {
    const f = fixture(), gate = deferred<void>(); closing.push(async () => gate.resolve())
    key = JSON.stringify(['draft', 'session-original'])
    await owner.editConversation([{ bucket: 'drafts', key, next: 'Alpha omega' }], owner.recordIdentity())
    f.submit.mockImplementation(async input => { const value = await acceptedPrompt(input); await gate.promise; return value })
    const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={{ state: 'connected', message: 'Original Host' }} platform={createBrowserPlatform()} />)
    panel = () => view.element
    await click(button(panel(), 'Send')); await wait(() => expect(f.submit).toHaveBeenCalledOnce())
    operation = () => f.submit.mock.calls[0]![0].operationId!
    release = async () => gate.resolve()
  }
  await replaceText(panel(), 'Later B'); await replaceText(panel(), 'Alpha omega')
  await wait(() => expect(new Map(owner.snapshot().record.conversation.drafts).get(key)).toBe('Alpha omega'))
  await act(release)
  await wait(() => expect([...new Map(owner.snapshot().record.conversation.attempts).values()].find(value => value.operationId === operation())?.phase).toBe('confirmed'))
  expect(editor(panel()).textContent).toBe('Alpha omega')
  expect(new Map(owner.snapshot().record.conversation.drafts).get(key)).toBe('Alpha omega')
})

it('actual Mobile Mote continuity keeps new B on session-conversation while the running Main still awaits native initialization', async () => {
  const f = await actualMote({ providerId: 'codex', draft: 'New B while initialization waits' })
  const main = await f.host.main.readCurrentMoteMain(f.host.target)
  await f.host.rpc.call('space.mote.dialogue.input.submit', { target: f.host.target, expectedRoleRevision: main.roleRevision!, input: {
    agentSessionId: f.ref.sessionId, expectedRun: f.session.run, operationId: 'original-waiting-A', prompt: 'Original A waits',
    admissionIntent: { kind: 'session-conversation' }, execution: 'immediate' } })
  await vi.waitFor(async () => {
    const a = await f.host.rpc.call('space.mote.dialogue.input.inspect', { target: f.host.target, operationId: 'original-waiting-A' })
    expect(a.input?.status).toBe('waiting'); expect(a.input?.control.waiting?.reason).toBe('native-session-starting')
  })
  expect(f.host.h.inner.kernel.input).not.toHaveBeenCalled()
  await wait(() => expect(f.panel().querySelector('.composer__editor')?.getAttribute('data-placeholder')).toBe('发消息'))
  await click(button(f.panel(), 'Send'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(1))
  const index = f.rpc.mock.calls.findIndex(([method]) => method === 'space.mote.dialogue.input.submit'), packet = f.rpc.mock.calls[index]![1]
  expect(packet.input.admissionIntent).toEqual({ kind: 'session-conversation' })
  expect(packet.input.prompt).toBe('New B while initialization waits')
  await f.rpc.mock.results[index]!.value
  await vi.waitFor(async () => {
    const b = await f.host.rpc.call('space.mote.dialogue.input.inspect', { target: f.host.target, operationId: packet.input.operationId })
    expect(b.input?.status).toBe('waiting'); expect(b.input?.control.waiting).toBeDefined()
  })
  expect(f.host.h.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.host.h.client.readAgentSession(f.ref.sessionId))?.run).toEqual(f.session.run)
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.sessionKey)).toBe('Original Session B draft')
  expect(editor(f.panel()).textContent).toBe('New B while initialization waits')
})

it('actual Mobile Mote continuity preserves the binding of an original saved manual producer', async () => {
  const f = await actualMote({ savedManual: true })
  await wait(() => expect(f.panel().textContent).toContain('核对主对话消息'))
  await click(button(f.panel(), '核对主对话消息'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(1))
  const packet = f.rpc.mock.calls.find(([method]) => method === 'space.mote.dialogue.input.submit')![1]
  expect(packet.input).toMatchObject({ operationId: 'original-saved-manual', prompt: 'Original saved manual body', admissionIntent: { kind: 'manual-actor' } })
  expect(new Map(f.owner.snapshot().record.conversation.attempts).get(f.sessionKey)).not.toHaveProperty('admissionIntent')
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Alpha omega')
})

it('actual Mobile Mote continuity selects the welcome Source while the original Session remains mounted but hidden', async () => {
  const f = await actualMote(), original = editor(f.panel())
  await wait(() => expect(f.panel().querySelector('.composer__editor')?.getAttribute('data-placeholder')).toBe('发消息'))
  await wait(() => expect(f.view.element.querySelector('button[aria-label="当前对话操作"]')).toBeTruthy())
  await click(button(f.view.element, '当前对话操作'))
  await wait(() => expect(document.body.querySelector('button[aria-label="新一轮"]')).toBeTruthy())
  await click(button(document.body, '新一轮'))
  await wait(() => expect(f.panel().querySelector('.mote-start[data-mode="new"]')).toBeTruthy())
  await f.view.render(f.render())
  expect(editor(f.panel())).toBe(original)
  expect(f.panel().querySelector('.mobile-conversation-slot')?.hasAttribute('hidden')).toBe(true)
  await wait(() => expect(button(f.panel(), 'Send').disabled).toBe(false))
  await click(button(f.panel(), 'Send'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(1))
  const created = f.rpc.mock.calls.find(([method]) => method === 'agent.open')![1]
  expect(created.moteMain.deferredInput.prompt).toBe('Alpha omega')
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(0)
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.sessionKey)).toBe('Original Session B draft')
  expect(editor(f.panel())).toBe(original)
})

it('actual Mobile Mote continuity keeps an undispatched input after a later same-Session welcome choice', async () => {
  const f = await actualMote(), gate = deferred<void>(); closing.push(async () => gate.resolve())
  await wait(() => expect(f.panel().querySelector('.composer__editor')?.getAttribute('data-placeholder')).toBe('发消息'))
  const read = f.f.client.readAgentSession.bind(f.f.client); let held = false
  vi.spyOn(f.f.client, 'readAgentSession').mockImplementation(async id => {
    const value = await read(id)
    if (!held && id === f.ref.sessionId) { held = true; await gate.promise }
    return value
  })
  await click(button(f.panel(), 'Send')); await wait(() => expect(held).toBe(true))
  await click(button(f.view.element, '当前对话操作'))
  await wait(() => expect(document.body.querySelector('button[aria-label="新一轮"]')).toBeTruthy()); await click(button(document.body, '新一轮'))
  await wait(() => expect(f.panel().querySelector('.mote-start[data-mode="new"]')).toBeTruthy())
  await act(async () => gate.resolve())
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.attempts).get(f.sessionKey)).toMatchObject({ phase: 'rejected', inputRequested: false }))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(0)
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Alpha omega')
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.sessionKey)).toBe('Original Session B draft')
})

it('actual Mobile Mote continuity retains original selected attachment bytes across welcome and back to the same Main', async () => {
  const f = await actualMote(), bytes = 'Original selected bytes'
  nativeDevicePorts.filePicker = { pickFiles: vi.fn().mockResolvedValue({ files: [{ name: 'notes.txt', mimeType: 'text/plain',
    size: bytes.length, blob: new NodeBlob([bytes]) as Blob }] }) } as unknown as NativeDevicePorts['filePicker']
  await wait(() => expect(f.panel().querySelector('.composer__editor')?.getAttribute('data-placeholder')).toBe('发消息'))
  await click(button(f.panel(), 'Reference files for the Agent to read'))
  await wait(() => expect(f.panel().querySelector('.mobile-attachment[data-phase="selected"]')).toBeTruthy())
  const originalOperation = f.panel().querySelector('.mobile-attachment-details')!.querySelectorAll('code')[3]!.textContent
  await click(button(f.view.element, '当前对话操作'))
  await wait(() => expect(document.body.querySelector('button[aria-label="新一轮"]')).toBeTruthy()); await click(button(document.body, '新一轮'))
  await wait(() => expect(f.panel().querySelector('.mobile-mote-start-details > summary')).toBeTruthy())
  await click(f.panel().querySelector('.mobile-mote-start-details > summary')!)
  await wait(() => expect([...f.panel().querySelectorAll('button')].some(value => value.textContent === '打开主对话')).toBe(true))
  await click(button(f.panel(), '打开主对话'))
  await wait(() => expect([...f.panel().querySelectorAll('button')].some(value => value.getAttribute('aria-label') === '上传并加入 notes.txt')).toBe(true))
  await click(button(f.panel(), '上传并加入 notes.txt'))
  await wait(() => expect(f.rpc.mock.calls.filter(([method]) => method === 'file.upload')).toHaveLength(1))
  const upload = f.rpc.mock.calls.find(([method]) => method === 'file.upload')![1]
  expect(upload).toMatchObject({ operationId: originalOperation, hostId: 'local', agentSessionId: f.ref.sessionId,
    expectedRun: f.session.run, name: 'notes.txt', dataBase64: Buffer.from(bytes).toString('base64') })
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Alpha omega')
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.sessionKey)).toBe('Original Session B draft')
})

it('actual Mobile Mote continuity keeps different Mote drafts separate when the second source is unconfirmed', async () => {
  const f = await actualMote(), target = { ...f.host.target, spaceId: 'other-original-mote', zoneId: 'other-original-zone' }
  await f.view.render(<div />)
  await f.owner.updatePresentation({ selectedSessionId: null, hostUrl: '', panel: 'conversation' }, { primary: 'mote', showSession: true,
    showGoalWork: false, recentMoteSpaceId: target.spaceId, profile: null,
    identity: { name: 'Other Mote', project: 'Other', mote: { spaceId: target.spaceId, name: 'Other Mote', contentReference: { ...target.expectedResource, zoneId: target.zoneId } } },
    moteView: { spaceId: target.spaceId, section: 'discussion', detail: false, directAgent: false } })
  await f.view.render(f.render())
  await wait(() => expect(f.panel().querySelector('.mobile-mote-composer [contenteditable="true"]')).toBeTruthy())
  expect(editor(f.panel()).textContent).toBe('')
  await paste(f.panel(), 'Other exact Mote text')
  const otherKey = mobileMoteStartDraftKey(f.f.client, target)
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(otherKey)).toBe('Other exact Mote text'))
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Alpha omega')
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.sessionKey)).toBe('Original Session B draft')
  expect(f.host.h.started).toHaveLength(1)
})

it('actual Mobile Mote text owner isolates editor undo and IME when the exact Mote changes', async () => {
  const f = await actualMote(), target = { ...f.host.target, spaceId: 'other-exact-mote', zoneId: 'other-exact-zone' }
  const otherKey = mobileMoteStartDraftKey(f.f.client, target)
  await f.view.render(<div />)
  await f.owner.editConversation([{ bucket: 'drafts', key: otherKey, next: 'Original B' }], f.owner.recordIdentity())
  const content = (selected: typeof target) => <MobileLocalDraftsOwner><MobileMoteComposer client={f.f.client} target={selected}
    enabled active sourceKey={mobileWelcomeComposerSource('start')} platform={createBrowserPlatform()}>
    <MobileComposerSource sourceKey={mobileWelcomeComposerSource('start')} value="" onChange={() => {}} />
  </MobileMoteComposer></MobileLocalDraftsOwner>
  await f.view.render(content(f.host.target)); const original = editor(f.view.element)
  await act(async () => selectText(original, 5)); await paste(f.view.element, ' revised')
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Alpha revised omega'))
  await act(async () => original.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  await f.view.render(content(target))
  const next = editor(f.view.element)
  expect(next).not.toBe(original); expect(original.isConnected).toBe(false); expect(next.textContent).toBe('Original B')
  await act(async () => {
    original.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'old composition' }))
    next.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', ctrlKey: true }))
  })
  expect(next.textContent).toBe('Original B')
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Alpha revised omega')
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(otherKey)).toBe('Original B')
  await f.view.render(content(f.host.target))
  expect(editor(f.view.element).textContent).toBe('Alpha revised omega')
  expect(f.host.h.started).toHaveLength(1)
})

it.each(['runtime', 'record'] as const)('actual Mobile Mote continuity retains the half draft when its %s source changes', async change => {
  const f = await actualMote(), original = editor(f.panel())
  await wait(() => expect(f.panel().querySelector('.composer__editor')?.getAttribute('data-placeholder')).toBe('发消息'))
  expect(button(f.panel(), 'Send').disabled).toBe(false)
  await paste(f.panel(), ' still typing')
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toContain('still typing'))
  const body = original.textContent
  if (change === 'runtime') { f.changeRuntime('another-runtime'); await f.view.render(f.render()) }
  else await act(async () => { await f.owner.replaceBackup(emptyDeviceWorkface()) })
  expect(editor(f.panel())).toBe(original); expect(original.textContent).toBe(body)
  expect(f.panel().textContent).toContain('草稿仍保留')
  expect(button(f.panel(), 'Send').disabled).toBe(true)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(0)
  if (change === 'record') expect(f.owner.snapshot().record.conversation.moteTextSources ?? []).toEqual([])
})

it('actual Mobile Mote continuity restores both original draft slots after a page restart without creating an Agent', async () => {
  const f = await actualMote(), original = editor(f.panel())
  await act(async () => selectText(original, 5)); await paste(f.panel(), ' saved')
  await wait(() => expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.key)).toBe('Alpha saved omega'))
  await f.view.render(<div />); await f.view.render(f.render())
  await wait(() => expect(f.panel().querySelector('.mobile-mote-composer [contenteditable="true"]')).toBeTruthy())
  expect(editor(f.panel()).textContent).toBe('Alpha saved omega')
  expect(new Map(f.owner.snapshot().record.conversation.drafts).get(f.sessionKey)).toBe('Original Session B draft')
  expect(f.host.h.started).toHaveLength(1)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(0)
})
