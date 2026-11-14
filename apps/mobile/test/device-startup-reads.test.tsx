import './mobile-lan-crypto.setup'
import { act } from 'react'
import { appendFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { createAttachmentPageOwner } from '../src/conversation/attachment-page-owner'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { DeviceWorkfaceStore, DEVICE_WORKFACE_KEY, emptyDeviceWorkface, getDeviceWorkface, type DeviceWorkface } from '../src/recovery/device-workface'
import { editor, fixture, mount, mounted } from './conversation-fixture'

const draftKey = JSON.stringify(['draft', 'session-original'])
function original(): DeviceWorkface {
  return { ...emptyDeviceWorkface(), recordId: 'original-device-record', selectedSessionId: 'session-original',
    hostUrl: 'http://127.0.0.1:54321', host: { origin: 'http://127.0.0.1:54321', hostId: 'host-original' },
    presentation: { primary: 'focus', showSession: true, showGoalWork: false,
      identity: { name: 'Original Agent', project: 'Original Project' }, profile: null },
    conversation: { version: 1, drafts: [[draftKey, 'retained-original-draft']],
      attempts: [[draftKey, { operationId: 'original-input', runId: 'run-original', draft: 'retained-original-input', phase: 'sending' }]],
      responses: [[JSON.stringify(['other', 'original-question']), { phase: 'sending' }]] },
    fileUploads: [{ runtimeId: 'original-runtime', phase: 'sending', identity: { hostId: 'host-original',
      agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, operationId: 'original-upload',
      name: 'original.txt', mimeType: 'text/plain', byteLength: 1, revision: 'sha256:' + 'a'.repeat(64) } }] }
}
function padded(targetBytes: number): DeviceWorkface {
  const record = original(), drafts = record.conversation.drafts
  for (let index = 0; index < 24; index++) drafts.push([JSON.stringify(['draft', `unrelated-${index}`]), ''])
  let remaining = targetBytes - Buffer.byteLength(JSON.stringify(record))
  for (let index = 1; index < drafts.length; index++) {
    const size = Math.ceil(remaining / (drafts.length - index))
    expect(size).toBeLessThanOrEqual(65536)
    drafts[index]![1] = 'x'.repeat(size); remaining -= size
  }
  expect(Buffer.byteLength(JSON.stringify(record))).toBe(targetBytes)
  return record
}
beforeEach(async () => { localStorage.clear(); history.replaceState(null, '', '/'); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

it.each([20 * 1024, 1536 * 1024])('restores %i bytes through MobileApp with one full device snapshot', async bytes => {
  const record = padded(bytes), raw = JSON.stringify(record), f = fixture()
  localStorage.setItem(DEVICE_WORKFACE_KEY, raw)
  const initialRead = vi.spyOn(f.client, 'readAgentConversation'), changes = vi.spyOn(f.client, 'readConversationChanges')
  f.client.forwardRpc = vi.fn().mockImplementation(async method => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], locations: [], bindings: [], agentPresentation: [] } }
    throw new Error('Unexpected observation: ' + method)
  })
  const originalFull = DeviceWorkfaceStore.prototype.snapshot
  const originalNavigation = DeviceWorkfaceStore.prototype.snapshotNavigation
  const originalUploads = DeviceWorkfaceStore.prototype.snapshotUploads
  const returnedCopies: Array<{ record: DeviceWorkface; stack: string | undefined }> = []
  const navigation: ReturnType<DeviceWorkfaceStore['snapshotNavigation']>[] = []
  const uploads: ReturnType<DeviceWorkfaceStore['snapshotUploads']>[] = []
  const fullRead = vi.spyOn(DeviceWorkfaceStore.prototype, 'snapshot').mockImplementation(function (this: DeviceWorkfaceStore) {
    const value = originalFull.call(this)
    returnedCopies.push({ record: value.record, stack: new Error().stack })
    return value
  })
  const navRead = vi.spyOn(DeviceWorkfaceStore.prototype, 'snapshotNavigation').mockImplementation(function (this: DeviceWorkfaceStore) {
    const value = originalNavigation.call(this); navigation.push(value); return value
  })
  const uploadRead = vi.spyOn(DeviceWorkfaceStore.prototype, 'snapshotUploads').mockImplementation(function (this: DeviceWorkfaceStore) {
    const value = originalUploads.call(this); uploads.push(value); return value
  })
  const started = performance.now()
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: 'original Host' }}
    platform={createBrowserPlatform()} restoreWorkface />)
  const originalEditor = editor(view.element)
  await vi.waitFor(() => {
    expect(view.element.textContent).toContain('原生回答')
    expect(editor(view.element).textContent).toBe('retained-original-draft')
    expect(view.element.textContent).toContain('重启前的消息还没确认送达')
  }, { timeout: 3000, interval: 10 })
  const mountElapsedMs = performance.now() - started
  fullRead.mockRestore(); navRead.mockRestore(); uploadRead.mockRestore()
  const copies = returnedCopies.map(copy => ({ bytes: Buffer.byteLength(JSON.stringify(copy.record)), stack: copy.stack }))
  if (process.env.DEVICE_STARTUP_READ_METRICS) appendFileSync(process.env.DEVICE_STARTUP_READ_METRICS,
    JSON.stringify({ bytes, mountElapsedMs, fullSnapshotCount: copies.length,
      logicalFullRecordBytes: copies.reduce((total, copy) => total + copy.bytes, 0),
      initialConversationReads: initialRead.mock.calls.length, checkpointReads: changes.mock.calls.length,
      navigationProjectionBytes: navigation.map(value => Buffer.byteLength(JSON.stringify(value))),
      uploadsProjectionBytes: uploads.map(value => Buffer.byteLength(JSON.stringify(value))), copies }) + '\n')
  // Observe actual calls through the mounted consumer, including reversion to
  // old full reads which bypasses the projected method entirely.
  expect(copies.filter(copy => copy.stack?.includes('loadWorkface (')), 'startup navigation must avoid full-record snapshots').toHaveLength(0)
  expect(copies.filter(copy => copy.stack?.includes('createAttachmentPageOwner (')), 'startup attachments must avoid full-record snapshots').toHaveLength(0)
  expect(copies, 'startup drafts must reuse one full snapshot').toHaveLength(1)
  expect(copies[0]!.bytes).toBe(bytes)
  expect(navigation).toEqual([{ workface: { selectedSessionId: record.selectedSessionId, hostUrl: record.hostUrl, panel: record.panel },
    presentation: record.presentation, issue: null }])
  expect(uploads).toEqual([{ uploads: record.fileUploads, recordId: record.recordId, issue: null }])
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(raw)
  expect(JSON.parse(getDeviceWorkface().exportBackup()).workface).toEqual(record)
  expect(editor(view.element)).toBe(originalEditor)
  expect(initialRead).toHaveBeenCalledOnce()
  // The original Reader may close its read→watch checkpoint before or after
  // this mount completes. Each actual changes call reads the same fixed frame.
  expect(f.readHistory).toHaveBeenCalledTimes(initialRead.mock.calls.length + changes.mock.calls.length)
  expect(f.readTimeline).toHaveBeenCalledTimes(f.readHistory.mock.calls.length)
  expect(f.readHistory.mock.calls.every(([id]) => id === 'session-original')).toBe(true)
  expect([...initialRead.mock.calls, ...changes.mock.calls].every(([input]) => input.agentSessionId === 'session-original')).toBe(true)
  expect(f.client.readAgentSession).toHaveBeenCalledExactlyOnceWith('session-original')
  expect(f.sessions.get('session-original')!.run.runId).toBe('run-original')
  expect(vi.mocked(f.client.forwardRpc!).mock.calls.map(([method]) => method)).toEqual(['space.ls'])
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it('keeps every saved presentation field and nested upload independent while full backup retains the original intents', () => {
  const record = original()
  record.presentation = { ...record.presentation!, primary: 'topics',
    profile: { identity: { name: 'Original Profile', project: 'Original Project' }, sourcePath: 'SOUL.md' },
    topics: { context: { categoryId: 'category-original', topicId: 'topic-original', mode: 'knowledge' }, sources: [] },
    goals: { goalId: 'goal-original', mode: 'edit', discussion: null },
    spatial: { spaceId: 'space-original', tabId: 'tab-original', regionId: 'region-original' },
    survey: { zoneId: 'zone-original', tabId: 'tab-survey', regionId: 'region-survey' },
    recentMoteSpaceId: 'mote-original', moteView: { spaceId: 'mote-original', section: 'threads', detail: false, directAgent: true } }
  localStorage.setItem(DEVICE_WORKFACE_KEY, JSON.stringify(record))
  const owner = getDeviceWorkface(), navigation = owner.snapshotNavigation(), uploads = owner.snapshotUploads()
  expect(navigation.presentation).toEqual(record.presentation)
  navigation.workface.selectedSessionId = 'changed-copy'
  navigation.presentation!.profile!.identity.name = 'changed-copy'
  navigation.presentation!.topics!.context.topicId = 'changed-copy'
  uploads.uploads[0]!.identity.expectedRun.runId = 'changed-copy'
  uploads.uploads.push({ ...uploads.uploads[0]!, phase: 'error' })
  expect(JSON.parse(owner.exportBackup()).workface).toEqual(record)
  expect(owner.snapshotNavigation().workface.selectedSessionId).toBe('session-original')
  expect(owner.snapshotUploads()).toEqual({ uploads: record.fileUploads, recordId: record.recordId, issue: null })
})

it('captures upload generation once and keeps the original receipt guard after a competing record replaces storage', () => {
  const record = original()
  record.fileUploads!.push({ ...record.fileUploads![0]!, identity: { ...record.fileUploads![0]!.identity, operationId: 'second-upload' } })
  const raw = JSON.stringify(record), replacement = JSON.stringify({ ...record, recordId: 'replacement-record' })
  localStorage.setItem(DEVICE_WORKFACE_KEY, raw)
  const device = getDeviceWorkface(); expect(device.recordIdentity()).toBe(record.recordId)
  const read = localStorage.getItem.bind(localStorage)
  let reads = 0
  const storageRead = vi.spyOn(localStorage, 'getItem').mockImplementation(key => {
    const value = read(key)
    // Controlled Storage leaf: the first read returns the original bytes; a
    // competing page's next generation is available to any subsequent read.
    if (key === DEVICE_WORKFACE_KEY && ++reads === 1) localStorage.setItem(key, replacement)
    return value
  })
  const attachment = createAttachmentPageOwner()
  expect(reads).toBe(1)
  expect([...attachment.recordIds.current.values()]).toEqual([record.recordId, record.recordId])
  expect(attachment.uploads.current.map(item => item.phase)).toEqual(['unknown', 'unknown'])
  expect(attachment.originalEntries.current.get('original-upload')).toEqual(record.fileUploads![0])
  storageRead.mockRestore()
  expect(device.recordIdentity()).toBe('replacement-record')
  expect(() => device.retainFileUpload({ ...record.fileUploads![0]!, phase: 'error' }, record.recordId)).toThrow('工作面已被替换')
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(replacement)
})

it('exports the complete temporary workface through the original draft owner while storage is unavailable', async () => {
  const record = original(), raw = JSON.stringify(record), device = getDeviceWorkface()
  localStorage.setItem(DEVICE_WORKFACE_KEY, raw)
  expect(device.recordIdentity()).toBe(record.recordId)
  const read = localStorage.getItem.bind(localStorage)
  vi.spyOn(localStorage, 'getItem').mockImplementation(key => {
    if (key === DEVICE_WORKFACE_KEY) throw new Error('isolated storage unavailable')
    return read(key)
  })
  const local = createLocalDrafts()
  expect(local.canSave).toBe(false)
  expect(local.notice).toContain('已存的记录尚未覆盖')
  expect(device.snapshotNavigation()).toMatchObject({ workface: { selectedSessionId: record.selectedSessionId },
    presentation: record.presentation, issue: expect.any(String) })
  expect(device.snapshotUploads()).toMatchObject({ uploads: record.fileUploads, recordId: record.recordId, issue: expect.any(String) })
  local.drafts.set(draftKey, 'temporary retained edit')
  await local.save()
  expect(local.canSave).toBe(false)
  expect(local.hasUnconfirmedSave).toBe(true)
  const exported = JSON.parse(local.exportBackup())
  expect(exported).toEqual({ schema: 'agentmux.mobile-workface.v1', workface: { ...record, conversation: {
    ...record.conversation, drafts: [[draftKey, 'temporary retained edit']],
    attempts: record.conversation.attempts.map(([key, attempt]) => [key, { ...attempt, phase: 'unknown' }]),
    responses: record.conversation.responses.map(([key, response]) => [key, { ...response, phase: 'unknown' }]) } } })
  expect(device.parseBackup(local.exportBackup())).toEqual(exported.workface)
  expect(read(DEVICE_WORKFACE_KEY)).toBe(raw)
})
