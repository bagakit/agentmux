import { act } from 'react'
import { appendFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { DEVICE_WORKFACE_KEY, DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const key = JSON.stringify(['draft', 'session-original'])
const unknown = { operationId: 'original-unknown', runId: 'run-original', draft: 'original input', phase: 'unknown' as const,
  message: 'unknown', inputRequested: true }
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  vi.restoreAllMocks()
})

it('retries the second draft after its write fails without treating a pending projection as committed', async () => {
  let raw: string | null = null, writes = 0
  const storage = { getItem: () => raw, setItem: (_: string, bytes: string) => {
    if (++writes === 2) throw new Error('one quota failure')
    raw = bytes
  } }
  const local = createLocalDrafts(() => storage)
  local.attempts.set(key, unknown)
  local.drafts.set(key, 'first durable body'); const first = local.save()
  local.drafts.set(key, 'second unsaved body'); const second = local.save()
  await Promise.all([first, second])
  expect(local.drafts.get(key)).toBe('second unsaved body')
  expect(JSON.parse(raw!).conversation.drafts).toEqual([[key, 'first durable body']])
  expect(local.notice).toContain('尚未持久保存')
  expect(JSON.parse(local.exportBackup()).workface.conversation.attempts).toEqual([[key, expect.objectContaining({ operationId: unknown.operationId, phase: 'unknown' })]])
  await local.save()
  expect(local.drafts.get(key)).toBe('second unsaved body')
  expect(JSON.parse(raw!).conversation.drafts).toEqual([[key, 'second unsaved body']])
  expect(JSON.parse(raw!).conversation.attempts).toEqual([[key, expect.objectContaining({ operationId: unknown.operationId, phase: 'unknown' })]])
  expect(local.notice).toBeNull()
})

it('keeps the mounted Mobile editor text through a failed second save and an explicit save retry', async () => {
  const f = fixture(), owner = getDeviceWorkface()
  const internal = owner as unknown as { exclusive<T>(action: () => T): Promise<T>; tail: Promise<unknown> }
  const exclusive = internal.exclusive.bind(owner)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  internal.exclusive = action => gate.then(() => exclusive(action))
  const write = localStorage.setItem.bind(localStorage)
  let writes = 0
  vi.spyOn(localStorage, 'setItem').mockImplementation((name, bytes) => {
    if (name === DEVICE_WORKFACE_KEY && ++writes === 2) throw new Error('one quota failure')
    write(name, bytes)
  })
  try {
    const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: 'connected' }} platform={createBrowserPlatform()} />)
    await paste(view.element, 'first body')
    await paste(view.element, ' second body')
    await act(async () => { release(); await internal.tail })
    expect(editor(view.element).textContent).toBe('first body second body')
    expect(JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!).conversation.drafts).toEqual([[key, 'first body']])
    await click(button(view.element, '重试保存'))
    await act(async () => { await internal.tail })
    expect(editor(view.element).textContent).toBe('first body second body')
    expect(JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!).conversation.drafts).toEqual([[key, 'first body second body']])
    expect(f.submit).not.toHaveBeenCalled()
  } finally { release(); internal.exclusive = exclusive }
})

it('refuses an old completed save after another reader replaces the device record', async () => {
  let raw: string | null = null
  const storage = { getItem: () => raw, setItem: (_: string, bytes: string) => { raw = bytes } }
  const owner = getDeviceWorkface(() => storage), other = new DeviceWorkfaceStore(() => storage)
  await owner.replaceBackup(emptyDeviceWorkface())
  const originalRecordId = owner.recordIdentity(), local = createLocalDrafts(() => storage)
  local.drafts.set(key, 'original reader body')
  local.attempts.set(key, unknown)
  const replacement = { ...emptyDeviceWorkface(), conversation: { version: 1 as const,
    drafts: [[key, 'imported body']] as Array<[string, string]>, attempts: [], responses: [] } }
  const internal = owner as unknown as { exclusive<T>(action: () => T): Promise<T> }
  const exclusive = internal.exclusive.bind(owner)
  internal.exclusive = async action => {
    const committed = await exclusive(action)
    await other.replaceBackup(replacement)
    return committed
  }
  try {
    expect(await local.save()).toBe(false)
    expect(local.recordChanged).toBe(true)
    expect(local.canSave).toBe(false)
    expect(local.drafts.get(key)).toBe('original reader body')
    expect(local.attempts.get(key)).toBe(unknown)
    const exported = JSON.parse(local.exportBackup()).workface
    expect(exported.recordId).toBe(originalRecordId)
    expect(exported.conversation.drafts).toEqual([[key, 'original reader body']])
    expect(exported.conversation.attempts).toEqual([[key, expect.objectContaining({ operationId: unknown.operationId, phase: 'unknown' })]])
    expect(await local.save()).toBe(false)
    expect(JSON.parse(raw!).conversation.drafts).toEqual([[key, 'imported body']])
  } finally { internal.exclusive = exclusive }
})

it('does not send from the mounted Mobile surface when import replaces the second admission save', async () => {
  const f = fixture(), owner = getDeviceWorkface(), other = new DeviceWorkfaceStore(() => localStorage)
  const platform = createBrowserPlatform(), copy = vi.spyOn(platform, 'copyText').mockResolvedValue(true)
  const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original"
    connection={{ state: 'connected', message: 'connected' }} platform={platform} />)
  const internal = owner as unknown as { exclusive<T>(action: () => T): Promise<T>; tail: Promise<unknown> }
  await paste(view.element, 'original reader body')
  await act(async () => { await internal.tail })
  const exclusive = internal.exclusive.bind(owner)
  let completed = 0
  internal.exclusive = async action => {
    const committed = await exclusive(action)
    // This is the last local admission write immediately before the public SDK call.
    if (++completed === 2) await other.replaceBackup({ ...emptyDeviceWorkface(), conversation: { version: 1,
      drafts: [[key, 'imported body']], attempts: [], responses: [] } })
    return committed
  }
  try {
    await click(button(view.element, 'Send'))
    await act(async () => { await internal.tail })
    expect(completed).toBe(2)
    expect(f.submit).not.toHaveBeenCalled()
    expect(editor(view.element).textContent).toBe('original reader body')
    expect(JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!).conversation.drafts).toEqual([[key, 'imported body']])
    await click(button(view.element, '复制本页保全备份'))
    const exported = JSON.parse(copy.mock.calls.at(-1)![0]).workface.conversation
    expect(exported.drafts).toEqual([[key, 'original reader body']])
    expect(exported.attempts).toEqual([[key, expect.objectContaining({ draft: 'original reader body',
      inputRequested: false, phase: 'rejected', manualInput: { agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, runtimeId: 'original-runtime' } })]])
  } finally { internal.exclusive = exclusive }
})

it.each(['text', 'full'] as const)('a late %s ACK cannot replace newer text after a cross-page conflict and an edit back to the original string', async mode => {
  let raw: string | null = null
  const page = () => ({ getItem: () => raw, setItem: (_: string, value: string) => { raw = value } })
  const firstPage = page(), secondPage = page(), readFirst = () => firstPage, readSecond = () => secondPage
  const owner = getDeviceWorkface(readFirst), seed = createLocalDrafts(readFirst)
  seed.drafts.set(key, 'original base'); await seed.save()
  const a = createLocalDrafts(readFirst), b = createLocalDrafts(readSecond)
  b.drafts.set(key, 'canonical peer body'); await b.save()
  const pendingKey = JSON.stringify(['draft', 'other-pending-session'])
  a.attempts.set(pendingKey, unknown)
  const edit = owner.editConversation.bind(owner)
  let release!: () => void, ready!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { ready = resolve })
  vi.spyOn(owner, 'editConversation').mockImplementationOnce(async (...args) => {
    const committed = await edit(...args); ready(); await held; return committed
  })
  a.drafts.set(key, 'edited original body')
  const first = mode === 'full' ? a.save() : a.saveText(key, 'original base')
  try {
    await entered
    a.drafts.set(key, 'intermediate correction'); await a.saveText(key, 'edited original body')
    expect(a.drafts.get(key)).toBe('canonical peer body')
    a.drafts.set(key, 'edited original body'); await a.saveText(key, 'canonical peer body')
    expect(JSON.parse(raw!).conversation.drafts).toContainEqual([key, 'edited original body'])
    expect(JSON.parse(raw!).conversation.attempts.some(([id]: [string, unknown]) => id === pendingKey)).toBe(mode === 'full')
    expect(a.hasUnconfirmedSave, 'The original held ACK is still pending after a later text receipt').toBe(true)
    const confirmedConflicts = a.conflicts
    release(); await first
    expect(a.hasUnconfirmedSave).toBe(false)
    expect(a.drafts.get(key), 'An older ACK cannot erase the later explicit edit, even after a text ABA').toBe('edited original body')
    expect(a.conflicts, 'An older ACK cannot hide an already observed newer conflict').toBe(confirmedConflicts)
    expect(a.attempts.get(pendingKey)).toBe(unknown)
    await a.save() // The complete intent fence still owns persistence before dispatch.
    const reopened = createLocalDrafts(readSecond)
    expect(reopened.drafts.get(key)).toBe('edited original body')
    expect(reopened.attempts.get(pendingKey)).toMatchObject({ operationId: unknown.operationId, phase: 'unknown' })
    expect(reopened.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ bucket: 'drafts', key, value: 'intermediate correction' })]))
  } finally { release(); await first }
})

import { MobileMoteComposer, mobileSessionComposerSource } from '../src/conversation/mote-composer'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'

it.each(['Session', 'Mote'])('text-only %s edits keep128 unrelated question intents outside application serialization', async mode => {
  const owner = getDeviceWorkface(), record = emptyDeviceWorkface()
  record.conversation.questions = Array.from({ length: 128 }, (_, i) => {
    const input = { source: { providerId: 'codex', nativeSessionId: 'held-native-' + i }, recordId: 'held-record', turnId: 'held-turn',
      operationId: 'held-op-' + i, expectedRun: { runId: 'held-run-' + i }, afterSubmissionId: null,
      answers: [{ questionId: 'held-question', answer: 'Original unrelated answer '.repeat(32) }] }
    return [questionReplyKey('unrelated-session-' + i, input), { hostId: 'host-original', runtimeId: 'original-runtime', phase: 'unknown', input }]
  })
  await owner.replaceBackup(record)
  const f = fixture(), platform = createBrowserPlatform(), target = { spaceId: 'original-mote', zoneId: 'original-zone',
    expectedResource: { hostId: 'local', workspaceId: 'original-workspace', workspacePath: f.client.agentSession('session-original').workspacePath } }
  const surface = <MobileConversationSurface client={f.client} agentSessionId="session-original"
    connection={{ state: 'connected', message: 'Original Host' }} platform={platform} />
  const view = await mount(mode === 'Mote' ? <MobileMoteComposer client={f.client} target={target} enabled active
    sourceKey={mobileSessionComposerSource('session-original')} platform={platform}>{surface}</MobileMoteComposer> : surface)
  const editing = vi.spyOn(owner, 'editConversation'), clone = structuredClone
  const copies = { serializeQuestionRecords: 0, otherQuestionRecords: 0, fullConversationRecords: 0, fullDeviceRecords: 0 }
  const cloning = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value: any, options?: any) => {
    if (value?.input?.operationId?.startsWith('held-op-')) {
      if (new Error().stack?.includes('at serialize (')) copies.serializeQuestionRecords++
      else copies.otherQuestionRecords++
    } else if (value?.conversation?.questions?.length === 128) copies.fullDeviceRecords += 128
    else if (value?.questions?.length === 128) copies.fullConversationRecords += 128
    return clone(value, options)
  })
  const writes = vi.spyOn(localStorage, 'setItem')
  await paste(view.element, 'x')
  await act(async () => { await (owner as any).tail })
  const measured = { ...copies }, transactions = editing.mock.calls.map(([edits, recordId]) => ({ edits, recordId }))
  const physical = writes.mock.calls.filter(([name]) => name === DEVICE_WORKFACE_KEY).map(([, bytes]) => new TextEncoder().encode(bytes).byteLength)
  cloning.mockRestore()
  const saved = JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!)
  if (process.env.MOBILE_DRAFT_COST_FACTS) appendFileSync(process.env.MOBILE_DRAFT_COST_FACTS, JSON.stringify({ mode, heldQuestions: 128,
    measured, transactions, physicalWrites: physical.length, physicalBytes: physical, preservedOriginalQuestions: saved.conversation.questions.length }) + '\n')
  expect(transactions).toHaveLength(1)
  expect(transactions[0]!.edits.every(edit => edit.bucket === 'drafts' || edit.bucket === 'moteTextSources')).toBe(true)
  expect(saved.conversation.questions).toEqual(record.conversation.questions)
  expect(f.submit).not.toHaveBeenCalled()
  expect(measured.serializeQuestionRecords, 'Text-only application path must not serialize unrelated original answers').toBe(0)
})

it('keeps the original Mote text owner when the device record changes under its live editor', async () => {
  const owner = getDeviceWorkface(), f = fixture(), platform = createBrowserPlatform()
  const target = { spaceId: 'original-mote', zoneId: 'original-zone',
    expectedResource: { hostId: 'local', workspaceId: 'original-workspace', workspacePath: f.client.agentSession('session-original').workspacePath } }
  const view = await mount(<MobileMoteComposer client={f.client} target={target} enabled active sourceKey={mobileSessionComposerSource('session-original')} platform={platform}>
    <MobileConversationSurface client={f.client} agentSessionId="session-original" connection={{ state: 'connected', message: 'Original Host' }} platform={platform} />
  </MobileMoteComposer>)
  await paste(view.element, 'Original live Mote text')
  await act(async () => { await (owner as any).tail })
  const original = JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!), textKey = original.conversation.drafts[0][0]
  await owner.replaceBackup({ ...emptyDeviceWorkface(), conversation: { version: 1,
    drafts: [[textKey, 'Replacement record text']], attempts: [], responses: [] } })
  const replacement = localStorage.getItem(DEVICE_WORKFACE_KEY)
  await paste(view.element, ' edited after replacement')
  await act(async () => { await (owner as any).tail })
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY), 'The old text owner never writes a newly imported record').toBe(replacement)
  expect(editor(view.element).textContent).toContain('Original live Mote text edited after replacement')
  expect(view.element.textContent).toContain('工作面已被替换')
  expect(f.submit).not.toHaveBeenCalled()
})
