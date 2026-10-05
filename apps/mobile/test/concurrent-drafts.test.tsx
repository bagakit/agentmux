import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { DeviceWorkfaceStore, DEVICE_WORKFACE_KEY, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'
const key = JSON.stringify(['draft', 'session-original'])
function pages() {
  let raw: string | null = null
  const storage = () => ({ getItem: () => raw, setItem: (_: string, value: string) => { raw = value } })
  const a = storage(), b = storage()
  return { a: () => a, b: () => b, record: () => JSON.parse(raw!) }
}
const unknown = { operationId: 'original-unknown', runId: 'run-original', draft: '原请求正文', phase: 'unknown' as const, message: 'unknown', inputRequested: true,
  request: { condition: { expectedRun: { runId: 'run-original' }, afterSubmissionId: 'original-predecessor' }, execution: 'default' as const, explicit: true, runtimeId: 'original-runtime' } }
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() } })
describe('device-owned concurrent draft edits', () => {
  it('merges two independent readers and navigation against the latest durable record, preserving original unknown intent after reopen', async () => {
    const disk = pages(), a = createLocalDrafts(disk.a), b = createLocalDrafts(disk.b)
    a.drafts.set(key, unknown.draft); a.attempts.set(key, unknown)
    b.drafts.set('other-session', '另一会话草稿')
    await Promise.all([a.save(), b.save(), new DeviceWorkfaceStore(disk.b).updateNavigation({ selectedSessionId: 'other-session', hostUrl: '', panel: 'terminal' })])
    const reopened = createLocalDrafts(disk.b)
    expect(reopened.drafts.get(key)).toBe(unknown.draft); expect(reopened.drafts.get('other-session')).toBe('另一会话草稿')
    expect(reopened.attempts.get(key)).toMatchObject({ ...unknown, message: expect.stringContaining('原输入回执未知') })
    expect(disk.record().panel).toBe('terminal')
  })
  it('treats another page writing during this pending save as normal concurrency, including snapshot and a second edit', async () => {
    const disk = pages(), a = createLocalDrafts(disk.a), b = createLocalDrafts(disk.b), owner = getDeviceWorkface(disk.b)
    const actual = owner as unknown as { exclusive<T>(action: () => T): Promise<T> }
    const exclusive = actual.exclusive.bind(owner)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    actual.exclusive = action => gate.then(() => exclusive(action))
    b.drafts.set('pending-first', '第一次编辑'); const first = b.save()
    a.drafts.set('other-page', '别页新内容'); await a.save()
    expect(owner.snapshot().issue).toBeNull()
    b.drafts.set('pending-second', '第二次编辑'); const second = b.save()
    expect(owner.snapshot().issue).toBeNull()
    release(); await Promise.all([first, second])
    expect(createLocalDrafts(disk.a).drafts).toEqual(new Map([['other-page', '别页新内容'], ['pending-first', '第一次编辑'], ['pending-second', '第二次编辑']]))
    expect(owner.snapshot().issue).toBeNull(); expect(b.notice).toBeNull()
  })
  it('does not let a late Goal receipt or upload replace an imported record even with the same business operation identity', async () => {
    const disk = pages(), owner = getDeviceWorkface(disk.a)
    const intent = { runtimeId: 'runtime', deviceHostId: null, goalId: 'goal', operationId: 'goal-operation', phase: 'unknown' as const, kind: 'confirm' as const, expectedRevision: 1 }
    await owner.replaceBackup({ ...emptyDeviceWorkface(), goalIntents: [intent] })
    const upload = { runtimeId: 'runtime', identity: { hostId: 'host', agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, operationId: 'upload-operation', name: 'note.txt', mimeType: 'text/plain', byteLength: 3, revision: 'sha256:' + 'a'.repeat(64) }, phase: 'unknown' as const }
    await owner.retainFileUpload(upload)
    const originalRecord = owner.recordIdentity()
    await owner.replaceBackup(owner.snapshot().record)
    const bytes = disk.record()
    expect(() => owner.settleGoalIntent(intent, 'confirmed', originalRecord)).toThrow('工作面已被替换')
    expect(() => owner.retainFileUpload({ ...upload, phase: 'error' }, originalRecord)).toThrow('工作面已被替换')
    expect(disk.record()).toEqual(bytes); expect(owner.snapshot().record.goalIntents).toEqual([intent]); expect(owner.snapshot().record.fileUploads).toEqual([upload])
  })
  it('keeps flights scoped to their record and refuses a stale phase receipt within the same record', async () => {
    const disk = pages(), owner = getDeviceWorkface(disk.a)
    const intent = { runtimeId: 'runtime', deviceHostId: null, goalId: 'goal', operationId: 'goal-operation', phase: 'sending' as const, kind: 'confirm' as const, expectedRevision: 1 }
    await owner.retainGoalIntent(intent)
    const oldRecord = owner.recordIdentity()
    await owner.replaceBackup(emptyDeviceWorkface())
    expect(owner.goalIntentRunning(intent.operationId)).toBe(false)
    await owner.retainGoalIntent(intent)
    owner.releaseGoalIntent(intent, oldRecord)
    expect(owner.goalIntentRunning(intent.operationId)).toBe(true)
    owner.releaseGoalIntent(intent)
    await owner.settleGoalIntent(intent, 'unknown', owner.recordIdentity(), intent)
    expect(() => owner.settleGoalIntent(intent, 'confirmed', owner.recordIdentity(), intent)).toThrow('意图已变化')
    expect(owner.snapshot().record.goalIntents?.[0]?.phase).toBe('unknown')
  })
  it('keeps the canonical unknown request and the competing body rather than replacing it with another operation or stale deletion', async () => {
    const disk = pages(), a = createLocalDrafts(disk.a), b = createLocalDrafts(disk.b)
    a.drafts.set(key, unknown.draft); a.attempts.set(key, unknown); await a.save()
    b.drafts.set(key, '竞争页面的新正文'); b.attempts.set(key, { ...unknown, operationId: 'competing-new-operation', draft: '竞争页面的新正文' }); await b.save()
    const reopened = createLocalDrafts(disk.a)
    expect(reopened.attempts.get(key)?.operationId).toBe('original-unknown')
    expect(reopened.attempts.get(key)?.request).toEqual(unknown.request)
    expect(reopened.conflicts).toContainEqual({ bucket: 'drafts', key, value: '竞争页面的新正文' })
    expect(b.attempts.get(key)?.operationId).toBe('original-unknown')
    expect(b.notice).toContain('两份正文')
  })
  it('does not let a stale deletion erase the original unknown operation or its body', async () => {
    const disk = pages(), seed = createLocalDrafts(disk.a)
    seed.drafts.set(key, unknown.draft); seed.attempts.set(key, { ...unknown, phase: 'rejected' }); await seed.save()
    const a = createLocalDrafts(disk.a), b = createLocalDrafts(disk.b)
    a.attempts.set(key, unknown); await a.save()
    b.attempts.delete(key); b.drafts.delete(key); await b.save()
    const reopened = createLocalDrafts(disk.a)
    expect(reopened.attempts.get(key)).toMatchObject({ operationId: unknown.operationId, draft: unknown.draft, phase: 'unknown', inputRequested: true })
  })
  it('refuses an old reader after backup replacement, preserving its original body and intent for export without writing the new record', async () => {
    const disk = pages(), owner = getDeviceWorkface(disk.a)
    await owner.replaceBackup(emptyDeviceWorkface())
    const old = createLocalDrafts(disk.a)
    await owner.replaceBackup({ ...emptyDeviceWorkface(), conversation: { version: 1, drafts: [[key, '导入后的正文']], attempts: [], responses: [] } })
    const imported = disk.record()
    old.drafts.set(key, '旧页面迟到正文'); old.attempts.set(key, unknown)
    expect(await old.save()).toBe(false)
    expect(disk.record()).toEqual(imported)
    expect(old.drafts.get(key)).toBe('旧页面迟到正文'); expect(old.attempts.get(key)?.request).toEqual(unknown.request)
    expect(JSON.parse(old.exportBackup()).workface.conversation.attempts).toEqual([[key, expect.objectContaining({ operationId: unknown.operationId, request: unknown.request })]])
    expect(old.canSave).toBe(false); expect(old.notice).toContain('工作面已被替换')
  })
  it('keeps a replaced page exportable through the real conversation and prevents dispatch into the imported record', async () => {
    const f = fixture(), platform = createBrowserPlatform(), copy = vi.spyOn(platform, 'copyText').mockResolvedValue(true)
    const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={{ state: 'connected', message: 'connected' }} platform={platform} />)
    await paste(view.element, '原页面正文')
    await getDeviceWorkface().replaceBackup({ ...emptyDeviceWorkface(), conversation: { version: 1, drafts: [[key, '导入后正文']], attempts: [], responses: [] } })
    const imported = localStorage.getItem(DEVICE_WORKFACE_KEY)
    await click(button(view.element, 'Send'))
    expect(f.submit).not.toHaveBeenCalled(); expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(imported)
    await click(button(view.element, '复制本页保全备份'))
    expect(JSON.parse(copy.mock.calls.at(-1)![0]).workface.conversation.drafts).toContainEqual([key, '原页面正文'])
    expect(view.element.textContent).toContain('工作面已被替换')
  })
  it('awaits the real draft owner before dispatch, so a competing unknown request prevents a second input without erasing either body', async () => {
    const f = fixture(), view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: 'connected' }} platform={createBrowserPlatform()} />)
    await paste(view.element, '当前页面的新正文')
    const other = createLocalDrafts(() => localStorage)
    other.attempts.set(key, unknown); await other.save()
    await click(button(view.element, 'Send'))
    expect(f.submit).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!).conversation.attempts[0][1].operationId).toBe(unknown.operationId)
    expect(view.element.textContent).toContain('保全的冲突内容')
    expect(view.element.textContent).toContain('当前页面的新正文')
  })
  it('keeps volatile editing and backup export when the cross-page lock cannot open; no original durable bytes are replaced', async () => {
    const disk = pages(), owner = getDeviceWorkface(disk.a), local = createLocalDrafts(disk.a)
    await owner.updateNavigation({ selectedSessionId: null, hostUrl: '', panel: 'conversation' })
    const before = disk.record()
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('storage denied') })
    local.drafts.set(key, '锁不可用旁编辑'); await local.save()
    expect(disk.record()).toEqual(before)
    expect(owner.exportBackup()).toContain('锁不可用旁编辑'); expect(local.notice).toContain('刷新保障不足')
    open.mockRestore()
  })
})
