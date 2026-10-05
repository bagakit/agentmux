import { describe, expect, it, vi } from 'vitest'
import { DeviceWorkfaceStore, DeviceWorkfaceRecordChangedError, emptyDeviceWorkface, parseDeviceWorkface } from '../src/recovery/device-workface'
import { freezeMobileKnowledgeInput, mobileKnowledgeDraftKey, parseMobileKnowledgeDraft,
  parseMobileKnowledgeDraftKey, type MobileKnowledgeDraft } from '../src/recovery/knowledge-drafts'

const scope = { origin: 'http://192.168.2.45:8443', runtimeId: 'original-runtime', deviceHostId: 'original-host' }
const topicId = 'view:original-knowledge', entryId = '11111111-1111-4111-8111-111111111111'
function draft(content = '原知识正文', entry = entryId): MobileKnowledgeDraft {
  return { topicId, entryId: entry, scope, title: '原知识', content, form: 'reference', certainty: 'fact',
    sources: [{ kind: 'topic', topicId, chatId: 'original-chat', threadId: 'original-thread' }],
    authoringScope: '', expectedRevision: 'sha256:' + 'a'.repeat(64), attempts: [], blockedAttemptId: null }
}
function pending(value = draft(), attemptId = 'original-local-attempt'): MobileKnowledgeDraft {
  const input = freezeMobileKnowledgeInput({ topicId: value.topicId, entryId: value.entryId, title: value.title, content: value.content,
    form: value.form, certainty: value.certainty, sources: value.sources, expectedRevision: value.expectedRevision })
  return { ...value, attempts: [{ attemptId, ownerInstanceId: 'original-process', input, phase: 'unknown', issue: '原回应未确认' }], blockedAttemptId: attemptId }
}
function disk() {
  let raw = JSON.stringify(emptyDeviceWorkface())
  const storage = { getItem: vi.fn(() => raw), setItem: vi.fn((_key: string, bytes: string) => { raw = bytes }) }
  return { storage, raw: () => raw, read: () => parseDeviceWorkface(JSON.parse(raw)) }
}
describe('Knowledge drafts use the original device transaction owner', () => {
  it('keeps distinct knowledge keys, Goal, route and conversation under concurrent original transactions', async () => {
    const d = disk(), a = new DeviceWorkfaceStore(() => d.storage), b = new DeviceWorkfaceStore(() => d.storage)
    const original = pending(), other = draft('另一条正文', '22222222-2222-4222-8222-222222222222')
    const goal = { goalId: 'original-goal', scope, title: '原目标', description: '原Goal正文', baseline: { title: '原目标', description: '原Goal正文', updatedAt: 7 }, operations: [] }
    await Promise.all([a.editKnowledgeDraft(null, original, null), b.editKnowledgeDraft(null, other, null),
      b.editGoalDraft(null, goal, null), a.editConversation([{ bucket: 'drafts', key: 'original-conversation', expected: undefined, next: '原未发正文' }], null),
      b.updatePresentation({ selectedSessionId: null, hostUrl: '', panel: 'conversation' }, { primary: 'topics', showSession: false, showGoalWork: false, identity: null, profile: null })])
    expect(d.read().knowledgeDrafts).toEqual([original, other]); expect(d.read().goalDrafts).toEqual([goal])
    expect(d.read().conversation.drafts).toEqual([['original-conversation', '原未发正文']]); expect(d.read().presentation?.primary).toBe('topics')
    expect(a.parseBackup(a.exportBackup())).toEqual(d.read()); expect(a.recordIdentity()).toBeNull()
  })
  it('acknowledges actual committed A, not optimistic B when B fails quota', async () => {
    const d = disk(), owner = new DeviceWorkfaceStore(() => d.storage), a = draft(), b = pending(draft('后来B全文'))
    const write = d.storage.setItem.getMockImplementation()!
    d.storage.setItem.mockImplementationOnce((key, bytes) => { write(key, bytes); d.storage.setItem.mockImplementationOnce(() => { throw new Error('B quota') }) })
    const first = owner.editKnowledgeDraft(null, a, null), second = owner.editKnowledgeDraft(a, b, null)
    const failure = second.catch(error => error)
    expect((await first).draft).toEqual(a); expect((await failure).message).toBe('B quota')
    expect(d.read().knowledgeDrafts).toEqual([a]); expect(owner.snapshot().record.knowledgeDrafts).toEqual([b])
    expect(owner.snapshot().issue).toContain('尚未持久保存')
  })
  it('preserves complete same-key canonical and conflicting unknown inputs without growing duplicate copies', async () => {
    const d = disk(), a = new DeviceWorkfaceStore(() => d.storage), b = new DeviceWorkfaceStore(() => d.storage)
    const first = pending(), other = pending(draft('另一页后来正文'), 'other-local-attempt')
    await a.editKnowledgeDraft(null, first, null)
    expect(await b.editKnowledgeDraft(null, other, null)).toEqual({ recordId: null, applied: false, draft: first, conflict: other })
    await b.editKnowledgeDraft(null, other, null)
    expect(d.read().knowledgeDrafts).toEqual([first]); expect(d.read().knowledgeDraftConflicts).toEqual([other])
    expect(a.parseBackup(a.exportBackup()).knowledgeDraftConflicts).toEqual([other])
  })
  it('separates full Host/runtime keys and refuses a cross-key CAS expected draft', async () => {
    const d = disk(), owner = new DeviceWorkfaceStore(() => d.storage), a = pending()
    const b = { ...pending(), scope: { ...scope, runtimeId: 'another-runtime' } }
    await owner.editKnowledgeDraft(null, a, null); await owner.editKnowledgeDraft(null, b, null)
    expect(d.read().knowledgeDrafts).toEqual([a, b])
    expect(() => owner.editKnowledgeDraft(a, b, null)).toThrow()
    const key = mobileKnowledgeDraftKey(topicId, entryId, b.scope)
    expect(parseMobileKnowledgeDraftKey(key)).toEqual({ topicId, entryId, scope: b.scope })
    expect(() => parseMobileKnowledgeDraftKey(JSON.stringify([scope.origin, null, scope.deviceHostId, topicId, entryId]))).toThrow()
  })
  it('refuses an old record callback without putting original text or conflict into replacement B', async () => {
    const d = disk(), owner = new DeviceWorkfaceStore(() => d.storage), original = pending()
    await owner.editKnowledgeDraft(null, original, null)
    await owner.replaceBackup({ ...emptyDeviceWorkface(), knowledgeDrafts: [original] })
    const before = d.raw()
    expect(() => owner.editKnowledgeDraft(original, { ...original, content: '旧页晚写' }, null)).toThrow(DeviceWorkfaceRecordChangedError)
    expect(d.raw()).toBe(before); expect(d.read().knowledgeDraftConflicts).toBeUndefined()
  })
  it('retains unfinished text but requires an exact frozen public input and preserves imported malformed bytes', () => {
    const d = disk(), owner = new DeviceWorkfaceStore(() => d.storage), value = pending(), input = value.attempts[0]!.input
    expect(Object.isFrozen(input)).toBe(true); expect(Object.isFrozen(input.sources)).toBe(true); expect(Object.isFrozen(input.sources[0])).toBe(true)
    expect(input).not.toHaveProperty('attemptId'); expect(input).not.toHaveProperty('operationId')
    expect(parseMobileKnowledgeDraft({ ...draft(), title: '', form: 'reference', sources: [] }).title).toBe('')
    const before = d.raw()
    for (const invalid of [
      { ...value, scope: { ...scope, runtimeId: null } },
      { ...value, attempts: [{ ...value.attempts[0], input: { ...input, expectedRevision: undefined, sources: [{ kind: 'topic', topicId, expectedRevision: input.expectedRevision }] } }] },
      { ...value, attempts: [{ ...value.attempts[0], input: { ...input, operationId: 'not-a-public-topic-field' } }] },
      { ...value, blockedAttemptId: 'missing-attempt' }
    ]) expect(() => owner.parseBackup(JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: { ...emptyDeviceWorkface(), knowledgeDrafts: [invalid] } }))).toThrow()
    expect(d.raw()).toBe(before); expect(d.storage.setItem).not.toHaveBeenCalled()
  })
})
