import { fixturePath } from '../../../test/fixture-values.mjs'
import { describe, expect, it } from 'vitest'
import { DEVICE_WORKFACE_KEY, DeviceWorkfaceStore, emptyDeviceWorkface } from '../src/recovery/device-workface'
import { freezeMoteFileWrite, moteFileDraftKey, parseMoteFileDraft, parseMoteFileDrafts, type MoteFileDraft } from '../src/recovery/mote-file-drafts'

const resource = { hostId: 'original-host', workspaceId: 'original-workspace', workspacePath: fixturePath("original/workspace"),
  zoneId: 'original-mote-zone', zonePath: fixturePath("original/workspace/second"), path: 'second/SOUL.md' }
const revision = 'sha256:' + 'a'.repeat(64)
function draft(body = '原中文稿\n完整末行'): MoteFileDraft {
  return { scope: { origin: 'http://192.168.2.45:8443', runtimeId: 'original-runtime', deviceHostId: 'original-device-host',
    spaceId: 'second-mote', path: 'SOUL.md', resource }, body, baseline: { status: 'read', content: '原保存全文', revision },
    attempts: [], blockedAttemptId: null }
}
function storage() {
  let raw: string | null = null
  return { getItem: (_key: string) => raw, setItem: (_key: string, bytes: string) => { raw = bytes } }
}
describe('Mote original file device draft contract', () => {
  it('keeps the complete original mapping, frozen request and later body through public-codec parsing', () => {
    const value = draft(), input = freezeMoteFileWrite({ zoneId: resource.zoneId, spaceId: value.scope.spaceId,
      path: value.scope.path, expectedResource: resource, content: '\uFEFF原保存\r\n中文末行\r\n', expectedRevision: revision })
    value.body = '未发的后来稿\n保留全文'; value.blockedAttemptId = 'original-attempt'
    value.attempts = [{ attemptId: 'original-attempt', ownerInstanceId: 'original-instance', kind: 'write', input, phase: 'unknown', issue: '原回执未确认' }]
    expect(parseMoteFileDraft(value)).toEqual(value)
    const opaque = { ...value, scope: { ...value.scope, runtimeId: '原runtime/'.repeat(512) },
      attempts: value.attempts.map(attempt => ({ ...attempt, ownerInstanceId: '原owner/'.repeat(512) })) }
    expect(() => parseMoteFileDraft(opaque)).not.toThrow()
    expect(parseMoteFileDraft(opaque)).toEqual(opaque)
    expect(Object.isFrozen(input.expectedResource)).toBe(true)
    expect(input.content).toBe('\uFEFF原保存\r\n中文末行\r\n')
    expect(() => parseMoteFileDraft({ ...value, attempts: [{ ...value.attempts[0], input: { ...input, expectedResource: { ...resource, zonePath: fixturePath("another/root") } } }] })).toThrow()
    expect(() => parseMoteFileDraft({ ...value, scope: { ...value.scope, path: 'other.md' } })).toThrow()
    expect(() => parseMoteFileDraft({ ...value, baseline: { status: 'read', content: 'full', revision: 'short-presentation-version' } })).toThrow()
    expect(() => parseMoteFileDrafts([value, value])).toThrow()
  })
  it('commits one exact key while preserving the whole other record and reopens it from backup in a new owner', async () => {
    const target = storage(), owner = new DeviceWorkfaceStore(() => target)
    await owner.replaceBackup({ ...emptyDeviceWorkface(), host: { origin: 'http://192.168.2.45:8443', hostId: 'original-device-host' },
      hostUrl: 'http://192.168.2.45:8443', selectedSessionId: 'original-session', panel: 'terminal',
      conversation: { version: 1, drafts: [['untouched', '原会话未发正文']], attempts: [], responses: [] } })
    const before = owner.snapshot().record, value = draft(), recordId = owner.recordIdentity()
    const ack = await owner.editMoteFileDraft(null, value, recordId)
    expect(ack).toEqual({ recordId, applied: true, draft: value, conflict: null })
    expect(owner.snapshot().record).toEqual({ ...before, moteFileDrafts: [value] })
    const reopened = new DeviceWorkfaceStore(() => target)
    expect(reopened.snapshot().record).toEqual(owner.snapshot().record)
    expect(reopened.parseBackup(owner.exportBackup())).toEqual(owner.snapshot().record)
    const independent = { ...draft('另一 Mote 未发稿'), scope: { ...value.scope, spaceId: 'first-mote',
      resource: { ...resource, zoneId: 'first-zone', zonePath: fixturePath("original/workspace/first"), path: 'first/SOUL.md' } } }
    await reopened.editMoteFileDraft(null, independent, recordId)
    await owner.editMoteFileDraft(value, draft('同原第二 Mote 后来稿'), recordId)
    expect(owner.snapshot().record.moteFileDrafts?.find(item => moteFileDraftKey(item.scope) === moteFileDraftKey(independent.scope))).toEqual(independent)
    const { moteFileDrafts: _drafts, ...unchanged } = owner.snapshot().record
    expect(unchanged).toEqual(before)
  })
  it('checks latest complete draft under the original lock and retains both conflicting bodies', async () => {
    const target = storage(), first = new DeviceWorkfaceStore(() => target), second = new DeviceWorkfaceStore(() => target)
    await first.replaceBackup(emptyDeviceWorkface())
    const value = draft(), recordId = first.recordIdentity()
    await first.editMoteFileDraft(null, value, recordId)
    const one = draft('第一页后来稿'), two = draft('第二页完整稿')
    await first.editMoteFileDraft(value, one, recordId)
    const ack = await second.editMoteFileDraft(value, two, recordId)
    expect(ack).toEqual({ recordId, applied: false, draft: one, conflict: two })
    expect(first.snapshot().record.moteFileDrafts).toEqual([one])
    expect(first.snapshot().record.moteFileDraftConflicts).toEqual([two])
    expect(second.parseBackup(second.exportBackup()).moteFileDraftConflicts).toEqual([two])
  })
  it('refuses an old record or different full scope without modifying the replacement', async () => {
    const target = storage(), owner = new DeviceWorkfaceStore(() => target)
    await owner.replaceBackup(emptyDeviceWorkface())
    const oldId = owner.recordIdentity(), value = draft()
    await owner.editMoteFileDraft(null, value, oldId)
    await owner.replaceBackup({ ...emptyDeviceWorkface(), conversation: { version: 1, drafts: [['new', '新的原稿']], attempts: [], responses: [] } })
    const before = target.getItem(DEVICE_WORKFACE_KEY)
    await expect(async () => owner.editMoteFileDraft(value, draft('旧页迟到稿'), oldId)).rejects.toThrow()
    expect(target.getItem(DEVICE_WORKFACE_KEY)).toBe(before)
    expect(() => owner.editMoteFileDraft(value, { ...value, scope: { ...value.scope, runtimeId: 'another-runtime' } }, owner.recordIdentity())).toThrow()
    expect(target.getItem(DEVICE_WORKFACE_KEY)).toBe(before)
  })
  it('does not report a pending projection or failed setItem as a committed draft', async () => {
    const target = storage(), owner = new DeviceWorkfaceStore(() => target)
    await owner.replaceBackup(emptyDeviceWorkface())
    const original = target.getItem(DEVICE_WORKFACE_KEY), recordId = owner.recordIdentity()
    const write = target.setItem
    target.setItem = () => { throw new Error('actual device storage unavailable') }
    await expect(owner.editMoteFileDraft(null, draft(), recordId)).rejects.toThrow('actual device storage unavailable')
    expect(target.getItem(DEVICE_WORKFACE_KEY)).toBe(original)
    expect(owner.canRetrySave()).toBe(true)
    expect(owner.snapshot().issue).not.toBeNull()
    target.setItem = write
  })
})
