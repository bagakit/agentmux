import { describe, expect, it } from 'vitest'
import { ipcResult, unwrapIpcResult, unwrapIpcResultMethods, BROWSER_PROFILE_RESULT_METHODS } from '../src/shared/ipc-result.js'
import { api } from '../src/renderer/src/lib/api.js'

describe('Profile IPC results carry the refusal code as data', () => {
  it('wraps a value and a coded refusal, survives a structured copy and restores the same Error fields', async () => {
    expect(await ipcResult(async () => ({ id: 'p1' }))).toEqual({ ok: true, value: { id: 'p1' } })
    const refused = await ipcResult(async () => { throw Object.assign(new Error('Changed.'), { code: 'BROWSER_PROFILE_REVISION_CONFLICT', detail: 'revision 3' }) })
    const copied = structuredClone(refused)
    expect(copied).toEqual({ ok: false, error: { code: 'BROWSER_PROFILE_REVISION_CONFLICT', message: 'Changed.', detail: 'revision 3' } })
    let caught: unknown
    try { unwrapIpcResult(copied) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({ message: 'Changed.', code: 'BROWSER_PROFILE_REVISION_CONFLICT', detail: 'revision 3' })
    // An uncoded failure keeps its message and gets the generic control code instead of losing both.
    expect(await ipcResult(() => { throw new Error('EIO') })).toEqual({ ok: false, error: { code: 'CONTROL_FAILED', message: 'EIO' } })
  })

  it('unwraps only the named methods and leaves every other method untouched', async () => {
    const other = () => 'kept'
    const unwrapped = unwrapIpcResultMethods<{ readProfiles(): Promise<number>; other(): string }, 'readProfiles'>({
      readProfiles: async () => ({ ok: true, value: 7 }), other }, ['readProfiles'])
    expect(await unwrapped.readProfiles()).toBe(7)
    expect(unwrapped.other).toBe(other)
  })

  it('makes the web preview refuse with the same codes the Desktop api restores', async () => {
    const list = await api.browser.readProfiles()
    await expect(api.browser.updateProfile(list.profiles[0]!.id, { label: 'Late' }, 'stale-profile-token'))
      .rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    await expect(api.browser.deleteProfile(list.profiles[0]!.id, {} as never)).rejects.toMatchObject({ code: 'BROWSER_DESTRUCTIVE_APPROVAL_REQUIRED' })
    // An uncoded preview refusal gets the code the Desktop envelope gives it, so components see one shape.
    await expect(api.browser.setDefaultProfile('missing-profile')).rejects.toMatchObject({ code: 'CONTROL_FAILED', message: 'Unknown Browser Profile: missing-profile' })
    expect(BROWSER_PROFILE_RESULT_METHODS).toContain('updateProfile')
  })

  it('makes the web preview store a pasted proxy line as its parsed server, as Main does', async () => {
    const list = await api.browser.readProfiles()
    const profile = await api.browser.updateProfile(list.profiles[0]!.id,
      { network: { mode: 'proxy', server: 'socks5://proxy.example:1080', bypass: ['intranet.example'] } }, list.profiles[0]!.revision)
    expect(profile.network).toEqual({ mode: 'proxy', server: { scheme: 'socks5', host: 'proxy.example', port: 1080 }, bypass: ['intranet.example'] })
    // A line with credentials is refused here too, so a preview never shows a password back in the field.
    const next = await api.browser.readProfiles()
    await expect(api.browser.updateProfile(list.profiles[0]!.id, { network: { mode: 'proxy', server: 'user:secret@proxy.example:8080' } }, next.profiles[0]!.revision))
      .rejects.toMatchObject({ code: 'BROWSER_PROFILE_NETWORK_INVALID' })
  })
})
