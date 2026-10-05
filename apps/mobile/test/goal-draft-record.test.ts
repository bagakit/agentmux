import { describe, expect, it, vi } from 'vitest'
import { DeviceWorkfaceStore, DeviceWorkfaceRecordChangedError, emptyDeviceWorkface, parseDeviceWorkface } from '../src/recovery/device-workface'
import { freezeMobileGoalUpdateRequest, type MobileGoalDraft } from '../src/recovery/goal-drafts'

const scope = { origin: 'http://192.168.2.45:8443', runtimeId: 'original-runtime', deviceHostId: 'original-host' }
function draft(goalId = 'original-goal', description = '原目标草稿'): MobileGoalDraft {
  return { goalId, scope, title: '原目标', description, baseline: { title: '原目标', description: '原意', updatedAt: 7 }, operations: [] }
}
function pending(value: MobileGoalDraft): MobileGoalDraft {
  return { ...value, operations: [{ request: freezeMobileGoalUpdateRequest({ goalId: value.goalId, operationId: 'original-operation', expectedUpdatedAt: 7, patch: { description: value.description } }),
    ownerInstanceId: 'original-process', phase: 'unknown', issue: '原回应尚未确认' }] }
}
function disk() {
  let raw = JSON.stringify(emptyDeviceWorkface())
  const storage = { getItem: vi.fn(() => raw), setItem: vi.fn((_key: string, next: string) => { raw = next }) }
  return { storage, raw: () => raw, read: () => parseDeviceWorkface(JSON.parse(raw)) }
}
describe('Goal drafts consume the original device transaction owner', () => {
  it('serializes different keys and preserves original conversation, route and complete unknown requests', async () => {
    const d = disk(), a = new DeviceWorkfaceStore(() => d.storage), b = new DeviceWorkfaceStore(() => d.storage)
    const first = pending(draft()), second = draft('another-goal', '另一页正文')
    await Promise.all([a.editGoalDraft(null, first, null), b.editGoalDraft(null, second, null)])
    await a.updateConversation({ version: 1, drafts: [['original-conversation', '原未发正文']], attempts: [], responses: [] })
    await b.updatePresentation({ selectedSessionId: null, hostUrl: '', panel: 'conversation' }, { primary: 'goals', showSession: false, showGoalWork: false, identity: null, profile: null })
    expect(d.read().goalDrafts).toEqual([first, second])
    expect(d.read().conversation.drafts).toEqual([['original-conversation', '原未发正文']])
    expect(a.recordIdentity()).toBeNull()
    expect(a.parseBackup(a.exportBackup())).toEqual(d.read())
  })
  it('returns A actual committed acknowledgement while later B is optimistic and its write fails', async () => {
    const d = disk(), owner = new DeviceWorkfaceStore(() => d.storage), a = draft(), b = pending({ ...a, description: '后写B正文' })
    const write = d.storage.setItem.getMockImplementation()!
    d.storage.setItem.mockImplementationOnce((key, bytes) => {
      write(key, bytes)
      d.storage.setItem.mockImplementationOnce(() => { throw new Error('B quota') })
    })
    const first = owner.editGoalDraft(null, a, null), second = owner.editGoalDraft(a, b, null)
    const failure = second.then(() => null, error => error)
    expect((await first).draft).toEqual(a)
    expect((await failure).message).toBe('B quota')
    expect(d.read().goalDrafts).toEqual([a])
    expect(owner.snapshot().record.goalDrafts).toEqual([b])
    expect(owner.snapshot().issue).toContain('尚未持久保存')
  })
  it('keeps same-key canonical and the other full body/unknown copy; repeated conflict does not grow the bucket', async () => {
    const d = disk(), a = new DeviceWorkfaceStore(() => d.storage), b = new DeviceWorkfaceStore(() => d.storage)
    const first = pending(draft()), other = pending({ ...draft(), description: '另一页未确认全文' })
    await a.editGoalDraft(null, first, null)
    const response = await b.editGoalDraft(null, other, null)
    expect(response).toEqual({ recordId: null, applied: false, draft: first, conflict: other })
    await b.editGoalDraft(null, other, null)
    expect(d.read().goalDrafts).toEqual([first]); expect(d.read().goalDraftConflicts).toEqual([other])
    expect(a.parseBackup(a.exportBackup()).goalDraftConflicts).toEqual([other])
  })
  it('uses the complete Host scope even for the same Goal and operation ID', async () => {
    const d = disk(), owner = new DeviceWorkfaceStore(() => d.storage), a = pending(draft()), b = pending({ ...draft(), scope: { ...scope, runtimeId: 'other-runtime' } })
    await owner.editGoalDraft(null, a, null); await owner.editGoalDraft(null, b, null)
    expect(d.read().goalDrafts).toEqual([a, b])
    expect(() => owner.editGoalDraft(a, b, null)).toThrow('原对象或 Host 不同')
    expect(d.read().goalDraftConflicts).toBeUndefined()
  })
  it('refuses a late callback after record replacement without inserting the original body or conflict into B', async () => {
    const d = disk(), owner = new DeviceWorkfaceStore(() => d.storage), a = pending(draft())
    await owner.editGoalDraft(null, a, null)
    await owner.replaceBackup({ ...emptyDeviceWorkface(), goalDrafts: [a] })
    const before = d.raw()
    expect(() => owner.editGoalDraft(a, { ...a, description: '旧页晚写' }, null)).toThrow(DeviceWorkfaceRecordChangedError)
    expect(d.raw()).toBe(before); expect(d.read().goalDraftConflicts).toBeUndefined()
  })
  it('strictly preserves top-level CAS/frozen original params and refuses malformed imports before any storage mutation', async () => {
    const d = disk(), owner = new DeviceWorkfaceStore(() => d.storage), value = pending(draft()), request = value.operations[0]!.request
    expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.patch)).toBe(true)
    const before = d.raw()
    for (const next of [{ ...value, scope: { ...scope, runtimeId: null } }, { ...value, operations: [{ ...value.operations[0], request: { ...request, expectedUpdatedAt: undefined, patch: { ...request.patch, expectedUpdatedAt: 7 } } }] }, { ...value, host: 'unverified' }]) {
      expect(() => owner.parseBackup(JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: { ...emptyDeviceWorkface(), goalDrafts: [next] } }))).toThrow()
    }
    expect(d.raw()).toBe(before); expect(d.storage.setItem).not.toHaveBeenCalled()
  })
})
