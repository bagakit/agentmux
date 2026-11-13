import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const writes = vi.hoisted(() => ({ before: undefined as undefined | (() => Promise<void>) }))
vi.mock('@agentmux/core', async original => {
  const actual = await original<typeof import('@agentmux/core')>()
  return { ...actual, durableWriteFile: async (...args: Parameters<typeof actual.durableWriteFile>) => {
    await writes.before?.()
    return actual.durableWriteFile(...args)
  } }
})
import { BrowserSitePermissions, type BrowserPermissionContext } from '../src/main/browser-site-permissions.js'
import { parseBrowserTargetsResult } from '../../../packages/core/src/control-browser-targets.js'

const originalOwner = {}
const roots: string[] = []
afterEach(async () => { writes.before = undefined; await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-site-permission-')); roots.push(root)
  const path = join(root, 'permissions.json'), changed = vi.fn()
  return { path, changed, owner: new BrowserSitePermissions(path, changed) }
}
function context(overrides: Partial<BrowserPermissionContext> = {}): BrowserPermissionContext {
  return { browserId: 'browser-1', navigationId: 'navigation-1', profileId: 'profile-1',
    origin: 'https://request.example', embeddingOrigin: 'https://embed.example', owner: originalOwner, current: () => true, ...overrides }
}
function current(owner: BrowserSitePermissions, scope = context()) {
  const request = owner.state(scope).requests[0]
  expect(request).toBeDefined()
  return { requestId: request!.requestId, navigationId: request!.navigationId }
}

describe('original native website permissions', () => {
  it('keeps a native request pending until an exact trusted choice, independent of saved-policy readability', async () => {
    const { path, owner } = await fixture(); await writeFile(path, 'unreadable permission document')
    const answer = vi.fn(), scope = context()
    owner.request(scope, ['camera', 'microphone'], answer)
    const request = current(owner)
    expect(answer).not.toHaveBeenCalled()
    await expect(owner.answer('another-browser', { ...request, allow: true, remember: false })).rejects.toThrow()
    expect(answer).not.toHaveBeenCalled()
    await owner.answer(scope.browserId, { ...request, allow: true, remember: true })
    expect(answer).toHaveBeenCalledExactlyOnceWith(true)
    expect(owner.check(scope, ['camera', 'microphone'])).toBe(true)
    expect(owner.state(scope).decisions).toEqual([
      { origin: scope.origin, embeddingOrigin: scope.embeddingOrigin, permission: 'camera', allow: true, scope: 'document' },
      { origin: scope.origin, embeddingOrigin: scope.embeddingOrigin, permission: 'microphone', allow: true, scope: 'document' }
    ])
    expect(owner.state(scope).warning).toContain('unconfirmed')
    expect(await readFile(path, 'utf8')).toBe('unreadable permission document')
    await expect(owner.answer(scope.browserId, { ...request, allow: true, remember: false })).rejects.toThrow()
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it('persists only the exact Profile/request origin/embedding origin and reloads it into a new owner', async () => {
    const { path, owner } = await fixture(), answer = vi.fn(), scope = context()
    owner.request(scope, ['geolocation'], answer)
    await owner.answer(scope.browserId, { ...current(owner), allow: true, remember: true })
    expect(answer).toHaveBeenCalledExactlyOnceWith(true)
    const restored = new BrowserSitePermissions(path, vi.fn()); await restored.retryRead()
    expect(restored.check(context({ browserId: 'browser-2' }), ['geolocation'])).toBe(true)
    expect(restored.check(context({ profileId: 'other-profile' }), ['geolocation'])).toBe(false)
    expect(restored.check(context({ origin: 'https://other.example' }), ['geolocation'])).toBe(false)
    expect(restored.check(context({ embeddingOrigin: 'https://other.example' }), ['geolocation'])).toBe(false)
    expect(restored.check(scope, ['camera'])).toBe(false)
    const decision = restored.state(scope).decisions[0]!
    expect(decision.scope).toBe('profile')
    await restored.forget(scope, decision)
    const afterForget = new BrowserSitePermissions(path, vi.fn()); await afterForget.retryRead()
    expect(afterForget.check(scope, ['geolocation'])).toBe(false)
    expect(JSON.parse(await readFile(path, 'utf8')).policies).toEqual([])
  })

  it('replaces saved policies only when rereading confirms the original file is missing, preserving document choices and unknown bytes', async () => {
    const { path, owner } = await fixture(), scope = context()
    owner.request(scope, ['camera'], vi.fn())
    await owner.answer(scope.browserId, { ...current(owner), allow: true, remember: true })
    owner.request(scope, ['microphone'], vi.fn())
    await owner.answer(scope.browserId, { ...current(owner), allow: true, remember: false })
    const next = context({ navigationId: 'new-document' })
    expect(owner.check(next, ['camera'])).toBe(true)
    await writeFile(path, 'original unknown policy bytes')
    await owner.retryRead()
    expect(owner.check(next, ['camera'])).toBe(true)
    expect(owner.state(next).warning).toContain('could not be read')
    expect(await readFile(path, 'utf8')).toBe('original unknown policy bytes')
    await rm(path)
    await owner.retryRead()
    expect(owner.check(next, ['camera'])).toBe(false)
    expect(owner.state(next)).toEqual({ requests: [], decisions: [] })
    expect(owner.check(scope, ['microphone'])).toBe(true)
    const native = vi.fn(); owner.request(next, ['camera'], native)
    expect(native).not.toHaveBeenCalled()
    expect(owner.state(next).requests).toHaveLength(1)
  })

  it('does not share document decisions between Profiles, Browsers, documents or embedding origins', async () => {
    const { owner } = await fixture(), scope = context()
    owner.request(scope, ['notifications'], vi.fn())
    await owner.answer(scope.browserId, { ...current(owner), allow: true, remember: false })
    expect(owner.check(scope, ['notifications'])).toBe(true)
    for (const other of [context({ browserId: 'other' }), context({ navigationId: 'next-document' }),
      context({ profileId: 'other' }), context({ embeddingOrigin: 'https://other.example' })]) {
      expect(owner.check(other, ['notifications'])).toBe(false)
    }
    await owner.forget(scope, owner.state(scope).decisions[0]!)
    expect(owner.check(scope, ['notifications'])).toBe(false)
  })

  it('coalesces equivalent original callbacks and cancels each once on real document loss', async () => {
    const { owner } = await fixture(), first = vi.fn(), second = vi.fn(), scope = context()
    owner.request(scope, ['microphone'], first); owner.request(scope, ['microphone'], second)
    expect(owner.state(scope).requests).toHaveLength(1)
    owner.cancel(scope.browserId, scope.owner)
    expect(first).toHaveBeenCalledExactlyOnceWith(false); expect(second).toHaveBeenCalledExactlyOnceWith(false)
    owner.cancel(scope.browserId, scope.owner)
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1)
    expect(owner.state(scope).requests).toEqual([])
  })

  it('keeps a pending original request over native same-document navigation with a fresh public navigation fence', async () => {
    const { owner } = await fixture(), answer = vi.fn()
    let navigationId = 'navigation-1'
    const scope = context({ current: () => navigationId === 'navigation-1' })
    owner.request(scope, ['geolocation'], answer)
    const before = current(owner, scope)
    navigationId = 'navigation-2'
    const after = context({ navigationId, current: () => navigationId === 'navigation-2' })
    owner.rebind(scope.browserId, scope.owner, origin => ({ ...after, origin }))
    expect(current(owner, after)).toEqual({ requestId: before.requestId, navigationId: 'navigation-2' })
    await expect(owner.answer(scope.browserId, { ...before, allow: true, remember: false })).rejects.toThrow()
    expect(answer).not.toHaveBeenCalled()
    await owner.answer(scope.browserId, { ...current(owner, after), allow: true, remember: false })
    expect(answer).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('keeps native callback-once even when projection and callback observers throw', async () => {
    const { path } = await fixture(), answer = vi.fn(() => { throw new Error('native observer ended') })
    const owner = new BrowserSitePermissions(path, () => { throw new Error('projection unavailable') }), scope = context()
    owner.request(scope, ['camera'], answer)
    await owner.answer(scope.browserId, { ...current(owner), allow: false, remember: false })
    await owner.retryRead()
    expect(answer).toHaveBeenCalledExactlyOnceWith(false)
    expect(owner.state(scope).requests).toEqual([])
    expect(owner.check(scope, ['camera'])).toBe(false)
  })

  it('makes a later Forget win while an earlier Remember is still writing, without revoking the delivered native answer', async () => {
    const { path, owner } = await fixture(), scope = context(), answer = vi.fn()
    let release!: () => void, started!: () => void, count = 0
    const held = new Promise<void>(done => { release = done }), writing = new Promise<void>(done => { started = done })
    writes.before = async () => { if (count++ === 0) { started(); await held } }
    owner.request(scope, ['camera'], answer)
    const remembering = owner.answer(scope.browserId, { ...current(owner), allow: true, remember: true })
    await writing
    expect(answer).toHaveBeenCalledExactlyOnceWith(true)
    const projected = owner.state(scope).decisions[0]!
    expect(projected.scope).toBe('document')
    const forgetting = owner.forget(scope, projected)
    release()
    await Promise.all([remembering, forgetting])
    expect(answer).toHaveBeenCalledExactlyOnceWith(true)
    expect(owner.check(scope, ['camera'])).toBe(false)
    const restored = new BrowserSitePermissions(path, vi.fn()); await restored.retryRead()
    expect(restored.check(scope, ['camera'])).toBe(false)
    expect(JSON.parse(await readFile(path, 'utf8')).policies).toEqual([])
  })

  it('can forget a purely document choice despite unreadable saved policies, without touching original bytes', async () => {
    const { path, owner } = await fixture(), scope = context(), answer = vi.fn()
    await writeFile(path, 'original unknown file')
    owner.request(scope, ['camera'], answer)
    await owner.answer(scope.browserId, { ...current(owner), allow: true, remember: false })
    await owner.forget(scope, owner.state(scope).decisions[0]!)
    expect(answer).toHaveBeenCalledExactlyOnceWith(true)
    expect(owner.check(scope, ['camera'])).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('original unknown file')
  })

  it('forgets only the selected document override without deleting a previously confirmed Profile policy', async () => {
    const { owner, path } = await fixture(), scope = context()
    owner.request(scope, ['camera'], vi.fn())
    await owner.answer(scope.browserId, { ...current(owner), allow: true, remember: true })
    owner.request(scope, ['camera', 'microphone'], vi.fn())
    await owner.answer(scope.browserId, { ...current(owner), allow: false, remember: false })
    const override = owner.state(scope).decisions.find(value => value.permission === 'camera')!
    expect(override).toMatchObject({ scope: 'document', allow: false })
    await owner.forget(scope, override)
    expect(owner.check(scope, ['camera'])).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8')).policies).toEqual([expect.objectContaining({ permission: 'camera', allow: true })])
  })

  it('does not erase a later native document choice when an earlier Forget finishes writing', async () => {
    const { owner, path } = await fixture(), scope = context()
    owner.request(scope, ['camera'], vi.fn())
    await owner.answer(scope.browserId, { ...current(owner), allow: true, remember: true })
    let release!: () => void, started!: () => void
    const held = new Promise<void>(done => { release = done }), writing = new Promise<void>(done => { started = done })
    writes.before = async () => { started(); await held }
    const forgetting = owner.forget(scope, owner.state(scope).decisions[0]!)
    await writing
    const later = vi.fn()
    owner.request(scope, ['camera', 'notifications'], later)
    await owner.answer(scope.browserId, { ...current(owner), allow: true, remember: false })
    release(); await forgetting
    expect(later).toHaveBeenCalledExactlyOnceWith(true)
    expect(owner.check(scope, ['camera'])).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8')).policies).toEqual([])
  })

  it('reserves Remember order before native callbacks or projection can re-enter with Forget', async () => {
    const { path } = await fixture(), scope = context()
    let forgetting: Promise<void> | undefined, armed = false
    const owner = new BrowserSitePermissions(path, () => {
      if (armed && owner.state(scope).decisions.length) {
        armed = false
        forgetting = owner.forget(scope, owner.state(scope).decisions[0]!)
      }
    })
    owner.request(scope, ['notifications'], vi.fn())
    armed = true
    await owner.answer(scope.browserId, { ...current(owner), allow: true, remember: true })
    expect(forgetting).toBeDefined(); await forgetting
    expect(JSON.parse(await readFile(path, 'utf8')).policies).toEqual([])
  })

  it('cancels only the retired native incarnation, preserving a new same-id request, decision and issue', async () => {
    const { owner } = await fixture(), old = context({ owner: {} }), fresh = context({ owner: {} })
    const oldAnswer = vi.fn(), freshAnswer = vi.fn()
    owner.request(old, ['camera'], oldAnswer)
    owner.request(fresh, ['microphone'], freshAnswer)
    owner.cancel(old.browserId, old.owner)
    expect(oldAnswer).toHaveBeenCalledExactlyOnceWith(false)
    expect(freshAnswer).not.toHaveBeenCalled()
    await owner.answer(fresh.browserId, { ...current(owner, fresh), allow: true, remember: false })
    owner.unavailable(fresh.browserId, fresh.owner, 'Original new-page observation')
    owner.cancel(old.browserId, old.owner)
    expect(owner.check(fresh, ['microphone'])).toBe(true)
    expect(owner.state(fresh).warning).toBe('Original new-page observation')
    expect(freshAnswer).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('keeps overlapping old/candidate observations bound to their exact native owner', async () => {
    const { owner } = await fixture(), old = context({ owner: {} }), candidate = context({ owner: {} })
    owner.unavailable(old.browserId, old.owner, 'Original observation')
    owner.unavailable(candidate.browserId, candidate.owner, 'Candidate observation')
    expect(owner.state(old).warning).toBe('Original observation')
    expect(owner.state(candidate).warning).toBe('Candidate observation')
    owner.cancel(old.browserId, old.owner)
    expect(owner.state(candidate).warning).toBe('Candidate observation')
  })

  it('decodes the original pending permission facts and rejects a mismatched public target', async () => {
    const { owner } = await fixture(), scope = context()
    owner.request(scope, ['camera'], vi.fn())
    const target = { id: scope.browserId, workspaceId: 'workspace', source: 'embedded', status: 'ready', mode: 'normal',
      profile: { id: scope.profileId!, label: 'Test' }, url: scope.embeddingOrigin, title: 'Page', navigationId: scope.navigationId,
      capabilities: [], sitePermissions: owner.state(scope) }
    const parsed = parseBrowserTargetsResult({ coverage: 'complete', targets: [target] })
    expect(parsed.targets).toHaveLength(1)
    expect(parsed.targets[0]!.sitePermissions?.requests).toEqual([expect.objectContaining({ permissions: ['camera'], requestId: expect.any(String) })])
    expect(() => parseBrowserTargetsResult({ coverage: 'complete', targets: [{ ...target, id: 'wrong-browser' }] })).toThrow()
  })
})
