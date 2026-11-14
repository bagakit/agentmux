// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserProfileList, BrowserProfileSummary } from '../src/shared/contracts'

const port = vi.hoisted(() => {
  const listeners = new Set<(list: BrowserProfileList) => void>()
  let list: BrowserProfileList = { revision: 0, sequence: 0, folders: [], views: [], profiles: [] }
  const commit = (next: BrowserProfileSummary[]) => { list = { revision: list.revision + 1, sequence: list.revision + 1, folders: [], views: [], profiles: next }; for (const listener of listeners) listener(list) }
  return {
    listeners, set(next: BrowserProfileList) { list = next }, get: () => list, commit,
    readProfiles: vi.fn(async () => list),
    onProfilesChanged: vi.fn((listener: (list: BrowserProfileList) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    updateProfile: vi.fn(async (id: string, edit: { label?: string; hue?: number | null; notes?: string; agentAccess?: boolean }, expected: string) => {
      if (expected !== list.profiles.find(profile => profile.id === id)?.revision) throw Object.assign(new Error('Browser Profiles changed since revision was read; current revision is ' + list.revision + '. Read them again and retry.'), { code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
      const next = list.profiles.map(profile => {
        if (profile.id !== id) return profile
        const updated: BrowserProfileSummary = { ...profile, revision: 'profile-token-' + (list.revision + 1), ...(edit.label === undefined ? {} : { label: edit.label }) }
        if (edit.hue === null) delete updated.hue; else if (edit.hue !== undefined) updated.hue = edit.hue
        if (edit.notes !== undefined) { if (edit.notes) updated.notes = edit.notes; else delete updated.notes }
        if (edit.agentAccess === false) updated.agentAccess = false; else if (edit.agentAccess === true) delete updated.agentAccess
        return updated
      })
      commit(next)
      return next.find(profile => profile.id === id)!
    }),
    setDefaultProfile: vi.fn(async () => {}),
    createProfile: vi.fn(async (label: string) => { const created = { id: 'p-new', revision: 'new-token', label, createdAt: 3, isDefault: false, source: null }; commit([...list.profiles, created]); return created }),
    deleteProfile: vi.fn(async () => {}),
    listProfileSites: vi.fn(async () => [{ site: 'github.com', cookies: 3 }, { site: 'example.com', cookies: 1 }]),
    clearProfileSite: vi.fn(async () => {}),
    readProfileProxySignIn: vi.fn(async (_id: string) => null as { username: string } | null),
    setProfileProxySignIn: vi.fn(async (_id: string, _signIn: { username: string; password: string } | null) => ({ reconnected: true })),
    checkProfileExit: vi.fn(async () => ({ status: 'reachable' as const, httpStatus: 200, latencyMs: 184.4, ip: '203.0.113.7' })),
    detectProfileImportSources: vi.fn(async () => []),
    importProfile: vi.fn()
  }
})
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: { ...port,
  createProfileIdentity: async (input: any) => { const created = await port.createProfile(input.label); return { revision: port.get().revision, creation: { operationId: input.operationId, receipt: { createdId: created.id }, current: { state: 'present' }, durability: 'confirmed' } } },
  inspectProfileCreation: async () => ({ creation: { receipt: null } })
}, ui: { requestStorageFlush: async () => {} } } }))
const store = vi.hoisted(() => ({
  tabs: {} as Record<string, unknown>,
  config: { browser: { agentAutomation: true } } as { browser: { agentAutomation: boolean; exitCheckUrl?: string } },
  layouts: {} as Record<string, { activeGroupId: string; groups: { id: string; tabOrder: string[] }[] }>,
  activeWorkspaceId: 'ws-1' as string | null,
  selectMainRegion: vi.fn((_reference: unknown) => true),
  createBrowser: vi.fn(async (..._args: unknown[]) => {}),
  reportError: vi.fn()
}))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign((select: (state: typeof store) => unknown) => select(store), { getState: () => store }) }))

import { browserProfiles } from '../src/renderer/src/lib/browser-profiles'
import { profileHue } from '../src/renderer/src/components/ProfileMark'
import { BrowserProfilesSettingsPane, PROFILE_HUES } from '../src/renderer/src/components/settings/BrowserProfilesSettingsPane'
import { clearsSemanticHues } from '../src/renderer/src/lib/conversation-avatar-color'

const personal: BrowserProfileSummary = { revision: 'personal-token', id: 'p-personal', label: 'Personal', createdAt: 1, isDefault: true, source: null }
const client: BrowserProfileSummary = { revision: 'client-token', id: 'p-client', label: 'Northwind client', createdAt: 2, isDefault: false, source: null, notes: 'Launch QA' }

function browserTab(id: string, profileId: string, deferred: boolean) {
  return { id: id === 'b-open' ? 't1' : 't2', workspaceId: 'ws-1', regions: { [id]: { kind: 'browser', browserId: id, profileId, title: id === 'b-open' ? 'Launch board' : 'Release notes', url: 'https://app.example/', ...(deferred ? { nativeOwnerDeferred: true } : {}) } } }
}

let root: Root, container: HTMLDivElement
const $ = <T extends Element = HTMLElement>(selector: string) => container.querySelector<T>(selector)
async function select(label: string) {
  const row = [...container.querySelectorAll<HTMLButtonElement>('[data-resource-row]')].find(button => button.textContent?.includes(label))
  expect(row, `row ${label}`).toBeDefined()
  await act(async () => row!.click())
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear(); browserProfiles.reset(); port.listeners.clear()
  for (const fn of [port.readProfiles, port.updateProfile, port.setDefaultProfile, port.createProfile, port.deleteProfile,
    port.readProfileProxySignIn, port.setProfileProxySignIn]) fn.mockClear()
  port.set({ revision: 4, sequence: 4, folders: [], views: [], profiles: [personal, client] })
  store.tabs = { t1: browserTab('b-open', 'p-client', false), t2: browserTab('b-saved', 'p-client', true) }
  store.layouts = { 'ws-1': { activeGroupId: 'g-1', groups: [{ id: 'g-1', tabOrder: ['t1'] }, { id: 'g-2', tabOrder: ['t2'] }] } }
  store.activeWorkspaceId = 'ws-1'
  for (const fn of [store.selectMainRegion, store.createBrowser, store.reportError]) fn.mockClear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<BrowserProfilesSettingsPane active />))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

describe('Settings › Browser Profiles', () => {
  it('lists every Profile with its mark, the default first in the editor, and open counts', () => {
    const rows = [...container.querySelectorAll('[data-resource-row]')]
    expect(rows.map(row => row.querySelector('strong')?.textContent)).toEqual(['Personal', 'Northwind client'])
    expect(rows[0]!.textContent).toContain('Default')
    expect(rows[1]!.textContent).toContain('1 open')
    expect(rows.every(row => row.querySelector('.profile-mark'))).toBe(true)
    expect($('.browser-profile-editor__name')?.textContent).toBe('Personal')
  })

  it('draws every automatic Profile in the list in its own color, the same in the list row and the editor header', async () => {
    // These four ids all hash to the same palette hue; only the list-wide assignment keeps them apart.
    const sameHash = ['p-1', 'p-10', 'p-11', 'p-14']
      .map((id, index) => ({ ...client, id, label: `Profile ${id}`, createdAt: 10 + index, hue: undefined, isDefault: false }))
    expect(new Set(sameHash.map(profile => profileHue({ id: profile.id }))).size, 'the ids must collide on their own').toBe(1)
    await act(async () => { port.set({ revision: 5, sequence: 5, folders: [], views: [], profiles: [personal, ...sameHash] }); await browserProfiles.refresh() })
    const rowHue = (label: string) => [...container.querySelectorAll<HTMLElement>('[data-resource-row]')]
      .find(row => row.textContent?.includes(label))!.querySelector<HTMLElement>('.profile-mark')!.style.getPropertyValue('--profile-hue')
    const hues = [personal.label, ...sameHash.map(profile => profile.label)].map(rowHue)
    expect(new Set(hues).size, JSON.stringify(hues)).toBe(hues.length)
    await select('Profile p-11')
    expect(container.querySelector<HTMLElement>('.browser-profile-editor__mark .profile-mark')!.style.getPropertyValue('--profile-hue')).toBe(rowHue('Profile p-11'))
  })

  it('keeps unobserved legacy activity unknown instead of displaying zero use or an edit count', () => {
    const observation = container.querySelector('[aria-label="Observed activity"]')!
    expect(observation.textContent).toContain('Last observed use: Unknown')
    expect(observation.textContent).toContain('Observed Browser time: Unknown')
    expect(observation.textContent).not.toContain('0 seconds')
    expect(observation.textContent).not.toContain('0 edits')
  })

  it('renames in place with the exact Profile token and shows the saved name everywhere', async () => {
    await select('Northwind client')
    await act(async () => $<HTMLButtonElement>('.browser-profile-editor__name')!.click())
    const input = $<HTMLInputElement>('input[aria-label="Profile name"]')!
    expect(document.activeElement).toBe(input)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Northwind QA'); input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(port.updateProfile).toHaveBeenCalledExactlyOnceWith('p-client', { label: 'Northwind QA' }, 'client-token')
    expect($('.browser-profile-editor__name')?.textContent).toBe('Northwind QA')
    expect([...container.querySelectorAll('[data-resource-row] strong')].map(node => node.textContent)).toContain('Northwind QA')
    expect($('.browser-profile-editor__saved')?.textContent).toContain('Saved')
  })

  it('Escape keeps the saved name and sends nothing', async () => {
    await act(async () => $<HTMLButtonElement>('.browser-profile-editor__name')!.click())
    const input = $<HTMLInputElement>('input[aria-label="Profile name"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Typo')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(port.updateProfile).not.toHaveBeenCalled()
    expect($('.browser-profile-editor__name')?.textContent).toBe('Personal')
  })

  it('offers only identity hues that clear status colors, and Automatic clears the choice', async () => {
    expect(PROFILE_HUES.length).toBeGreaterThan(4)
    expect(PROFILE_HUES.every(clearsSemanticHues)).toBe(true)
    await act(async () => $<HTMLButtonElement>('.browser-profile-editor__mark')!.click())
    const swatches = [...container.querySelectorAll<HTMLButtonElement>('.browser-profile-editor__hues > button[style]')]
    expect(swatches).toHaveLength(PROFILE_HUES.length)
    await act(async () => swatches[1]!.click())
    expect(port.updateProfile).toHaveBeenLastCalledWith('p-personal', { hue: PROFILE_HUES[1] }, 'personal-token')
    await act(async () => $<HTMLButtonElement>('.browser-profile-editor__mark')!.click())
    await act(async () => $<HTMLButtonElement>('.browser-profile-editor__auto')!.click())
    expect(port.updateProfile).toHaveBeenLastCalledWith('p-personal', { hue: null }, 'profile-token-5')
  })

  it('lists live and not-yet-loaded Browsers as in use and never offers to delete that Profile', async () => {
    await select('Northwind client')
    const uses = [...container.querySelectorAll('.browser-profile-editor__uses li')].map(li => li.textContent)
    expect(uses).toEqual(['Launch boardRunning', 'Release notesNot loaded yet'])
    expect($('.browser-profile-editor__who small')?.textContent).toContain('Open in 1 Browser')
  })

  it('commits only the completed note when a blur interrupts IME composition', async () => {
    await select('Northwind client')
    await act(async () => $<HTMLButtonElement>('.browser-profile-editor__note')!.click())
    const notes = $<HTMLTextAreaElement>('textarea[aria-label="Notes"]')!
    const next = $<HTMLButtonElement>('.browser-profile-editor__open')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      notes.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      setValue.call(notes, '仮'); notes.dispatchEvent(new Event('input', { bubbles: true }))
      notes.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))
      next.focus()
    })
    expect($('textarea[aria-label="Notes"]')).toBe(notes)
    expect(port.updateProfile).not.toHaveBeenCalled()
    await act(async () => {
      notes.dispatchEvent(new CompositionEvent('compositionend', { data: '確定', bubbles: true }))
      setValue.call(notes, '確定したメモ'); notes.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(port.updateProfile).toHaveBeenCalledExactlyOnceWith(client.id, { notes: '確定したメモ' }, client.revision)
    expect(document.activeElement).toBe(next)
    expect($('.browser-profile-editor__note')?.textContent).toBe('確定したメモ')
  })

  it('keeps later note input mounted and submits its next blur on the confirmed revision', async () => {
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const update = port.updateProfile.getMockImplementation()!
    port.updateProfile.mockImplementationOnce(async (...args) => { await gate; return update(...args) })
    await select('Northwind client')
    await act(async () => $<HTMLButtonElement>('.browser-profile-editor__note')!.click())
    const notes = $<HTMLTextAreaElement>('textarea[aria-label="Notes"]')!
    const next = $<HTMLButtonElement>('.browser-profile-editor__open')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(notes, 'First note'); notes.dispatchEvent(new Event('input', { bubbles: true }))
      next.focus()
    })
    expect(port.updateProfile).toHaveBeenCalledExactlyOnceWith(client.id, { notes: 'First note' }, client.revision)
    expect($('textarea[aria-label="Notes"]')).toBe(notes)
    await act(async () => {
      notes.focus()
      setValue.call(notes, 'Later note'); notes.dispatchEvent(new Event('input', { bubbles: true }))
      next.focus()
    })
    expect(port.updateProfile).toHaveBeenCalledTimes(1)
    await act(async () => release())
    expect(port.updateProfile).toHaveBeenLastCalledWith(client.id, { notes: 'Later note' }, 'profile-token-5')
    expect($('.browser-profile-editor__note')?.textContent).toBe('Later note')
    expect(document.activeElement).toBe(next)
  })

  it('does not label a conflicting note with an earlier confirmed save', async () => {
    const next = $<HTMLButtonElement>('.browser-profile-editor__open')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    const writeAndBlur = async (text: string) => {
      await act(async () => $<HTMLButtonElement>('.browser-profile-editor__note')!.click())
      const note = $<HTMLTextAreaElement>('textarea[aria-label="Notes"]')!
      await act(async () => { setValue.call(note, text); note.dispatchEvent(new Event('input', { bubbles: true })); next.focus() })
    }
    await writeAndBlur('Earlier confirmed note')
    expect($('.browser-profile-editor__saved')?.textContent).toContain('Saved')
    port.updateProfile.mockRejectedValueOnce(Object.assign(new Error('Another edit was confirmed first.'), { code: 'BROWSER_PROFILE_REVISION_CONFLICT' }))
    await writeAndBlur('Current draft')
    expect($<HTMLTextAreaElement>('textarea[aria-label="Notes"]')?.value).toBe('Current draft')
    expect($('[role="alert"]')?.textContent).toContain('Another edit was confirmed first.')
    expect($('.browser-profile-editor__saved')).toBeNull()
  })

  it('a refused edit keeps the editor usable and offers Reload for a changed list', async () => {
    port.set({ revision: 9, sequence: 9, folders: [], views: [], profiles: [{ ...personal, revision: 'personal-updated' }, client] })
    await act(async () => $<HTMLButtonElement>('.browser-profile-editor__note')!.click())
    const notes = $<HTMLTextAreaElement>('textarea[aria-label="Notes"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(notes, 'Personal sign-ins')
      notes.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => notes.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(port.updateProfile).toHaveBeenCalledWith('p-personal', { notes: 'Personal sign-ins' }, 'personal-token')
    expect($('[role="alert"]')?.textContent).toContain('changed since')
    expect($('textarea[aria-label="Notes"]')).toBe(notes)
    const reload = [...container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find(button => button.textContent === 'Reload')!
    // A macOS pointer click need not move focus to the button: prevent its mousedown
    // from blurring the retained editor and starting another stale save before click.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => reload.dispatchEvent(down))
    expect(down.defaultPrevented).toBe(true)
    const callsBeforeRecovery = port.updateProfile.mock.calls.length
    await act(async () => $<HTMLTextAreaElement>('textarea[aria-label="Notes"]')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: reload })))
    expect(port.updateProfile.mock.calls).toHaveLength(callsBeforeRecovery)
    await act(async () => reload.click())
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]')?.value).toBe('Personal sign-ins')
    await act(async () => $<HTMLTextAreaElement>('textarea[aria-label="Notes"]')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(port.updateProfile).toHaveBeenLastCalledWith('p-personal', { notes: 'Personal sign-ins' }, 'personal-updated')
    expect(port.get().profiles.find(value => value.id === personal.id)!.notes).toBe('Personal sign-ins')
    expect(port.readProfiles).toHaveBeenCalledTimes(2)
    expect($<HTMLButtonElement>('button.small-button')!.disabled).toBe(false)
  })

  it('offers Reload by the refusal code, not by its wording', async () => {
    const editNotes = async (text: string) => {
      await act(async () => $<HTMLButtonElement>('.browser-profile-editor__note')!.click())
      const notes = $<HTMLTextAreaElement>('textarea[aria-label="Notes"]')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(notes, text)
        notes.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => notes.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    }
    const reload = () => [...container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find(button => button.textContent === 'Reload')
    // A conflict with entirely different wording still offers Reload.
    port.updateProfile.mockRejectedValueOnce(Object.assign(new Error('Someone else saved first.'), { code: 'BROWSER_PROFILE_REVISION_CONFLICT' }))
    await editNotes('First try')
    expect($('[role="alert"]')?.textContent).toContain('Someone else saved first.')
    expect(reload()).toBeDefined()
    await act(async () => container.querySelector('textarea[aria-label="Notes"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    // A different refusal that happens to say "changed since" offers no Reload.
    port.updateProfile.mockRejectedValueOnce(Object.assign(new Error('Disk changed since the last check; nothing was written.'), { code: 'EIO' }))
    await editNotes('Second try')
    expect($('[role="alert"]')?.textContent).toContain('changed since')
    expect(reload()).toBeUndefined()
  })

  it('a failed refresh keeps the last list and every action available', async () => {
    port.readProfiles.mockRejectedValueOnce(new Error('EACCES'))
    await act(async () => { await browserProfiles.refresh() })
    expect($('.browser-profiles-settings__service')?.textContent).toContain('showing the last list')
    expect(container.querySelectorAll('[data-resource-row]')).toHaveLength(2)
    expect([...container.querySelectorAll<HTMLButtonElement>('.settings-pane-toolbar button')].every(button => !button.disabled)).toBe(true)
  })

  it('says why cookies were skipped on an imported Profile, by reason and count', async () => {
    port.set({ revision: 4, sequence: 4, folders: [], views: [], profiles: [personal, { ...client, source: { browserLabel: 'Google Chrome', profileLabel: 'Work', importedAt: 1, importedCookies: 40, skippedCookies: 5,
      skippedByReason: { 'app-bound-encryption': 3, expired: 2 } } }] })
    await act(async () => { await browserProfiles.refresh() })
    await select('Northwind client')
    const imported = container.querySelector('[aria-label="Imported"]')!
    expect(imported.querySelector('p')?.textContent).toBe('Google Chrome · Work: 40 cookies, 5 skipped')
    expect([...imported.querySelectorAll('.browser-profile-editor__skips li')].map(li => li.textContent))
      .toEqual(['Already expired2', 'Locked to the other browser by its app-bound encryption3'])
  })

  it('New Profile opens straight into naming the new Profile', async () => {
    const create = container.querySelector<HTMLButtonElement>('.settings-pane-toolbar button[aria-label="New Profile"]')!
    await act(async () => create.click())
    expect(port.createProfile).toHaveBeenCalledWith('Profile 1')
    expect(document.activeElement).toBe($('input[aria-label="Profile name"]'))
  })
})

describe('Settings › Browser Profiles deletion', () => {
  const deleteItem = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith('Delete Profile'))!
  async function openMore() {
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="More for "]')!
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
  }

  it('names why a default or in-use Profile cannot be deleted before anyone clicks', async () => {
    await openMore()
    expect(deleteItem().textContent).toContain('The default Profile can’t be deleted')
    expect(deleteItem().hasAttribute('data-disabled')).toBe(true)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await select('Northwind client')
    await openMore()
    expect(deleteItem().textContent).toContain('Used by 2 Browsers')
    expect(deleteItem().hasAttribute('data-disabled')).toBe(true)
  })

  it('an unused Profile confirms in place, sends only its own approval, and Cancel sends nothing', async () => {
    store.tabs = {}
    await act(async () => root.render(<BrowserProfilesSettingsPane active />))
    await select('Northwind client')
    await openMore()
    await act(async () => deleteItem().click())
    const confirm = container.querySelector('[role="alertdialog"]')!
    expect(confirm.textContent).toContain('Delete Northwind client? Its sign-ins, cookies, site data and address history are removed for good.')
    await act(async () => confirm.querySelector<HTMLButtonElement>('.small-button')!.click())
    expect(port.deleteProfile).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    await openMore()
    await act(async () => deleteItem().click())
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alertdialog"] .danger-button')!.click())
    expect(port.deleteProfile).toHaveBeenCalledExactlyOnceWith('p-client', { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: 'p-client' })
  })

  it('a delete whose site data is still clearing leaves the editor and keeps saying so', async () => {
    store.tabs = {}
    port.deleteProfile.mockImplementationOnce(async () => {
      port.commit(port.get().profiles.filter(profile => profile.id !== 'p-client'))
      throw Object.assign(new Error('Northwind client was deleted, but clearing its sign-ins and site data did not finish. AgentMux clears it again when it next starts.'),
        { code: 'BROWSER_PROFILE_DATA_CLEAR_PENDING' })
    })
    await act(async () => root.render(<BrowserProfilesSettingsPane active />))
    await select('Northwind client')
    await openMore()
    await act(async () => deleteItem().click())
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alertdialog"] .danger-button')!.click())
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(container.querySelector('.browser-profile-editor__name')?.textContent).toBe('Personal')
    expect(container.querySelector('.browser-profile-editor__error')).toBeNull()
    const notice = container.querySelector('.browser-profiles-settings__service[role="status"]')
    expect(notice?.textContent).toContain('clears it again when it next starts')
    await act(async () => notice!.querySelector<HTMLButtonElement>('button')!.click())
    expect(container.querySelector('.browser-profiles-settings__service')).toBeNull()
  })

  it('keeps the Profile and Main’s reason when Main refuses the delete', async () => {
    store.tabs = {}
    port.deleteProfile.mockRejectedValueOnce(new Error('Browser Profile is still used by the saved Browser "Release notes". Open it and switch it to another Profile, or close it, then delete again.'))
    await act(async () => root.render(<BrowserProfilesSettingsPane active />))
    await select('Northwind client')
    await openMore()
    await act(async () => deleteItem().click())
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alertdialog"] .danger-button')!.click())
    expect(container.querySelector('.browser-profile-editor__name')?.textContent).toBe('Northwind client')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('saved Browser "Release notes"')
  })
})

describe('Settings › Browser Profiles keeps what the person typed', () => {
  const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  it('reopens a refused rename with the typed name and a refused note with the typed note', async () => {
    port.updateProfile.mockRejectedValueOnce(Object.assign(new Error('Browser Profiles changed since revision was read.'), { code: 'BROWSER_PROFILE_REVISION_CONFLICT' }))
    await act(async () => container.querySelector<HTMLButtonElement>('.browser-profile-editor__name')!.click())
    await type(container.querySelector<HTMLInputElement>('input[aria-label="Profile name"]')!, 'Personal sign-ins')
    await act(async () => container.querySelector('input[aria-label="Profile name"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Profile name"]')?.value).toBe('Personal sign-ins')

    await act(async () => container.querySelector('input[aria-label="Profile name"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    port.updateProfile.mockRejectedValueOnce(new Error('EIO'))
    await act(async () => container.querySelector<HTMLButtonElement>('.browser-profile-editor__note')!.click())
    await type(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]')!, 'For banking only')
    await act(async () => container.querySelector('textarea[aria-label="Notes"]')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]')?.value).toBe('For banking only')
  })

  it('names a new Profile with the lowest number not in use', async () => {
    await act(async () => root.unmount())
    root = createRoot(container)
    browserProfiles.reset()
    port.set({ revision: 4, sequence: 4, folders: [], views: [], profiles: [personal, { ...client, label: 'Profile 1' }, { ...client, id: 'p-3', label: 'Profile 3' }] })
    await act(async () => root.render(<BrowserProfilesSettingsPane active />))
    const create = container.querySelector<HTMLButtonElement>('.settings-pane-toolbar button[aria-label="New Profile"]')!
    await act(async () => create.click())
    expect(port.createProfile).toHaveBeenCalledWith('Profile 2')
  })

  it('finds a Profile by its note or import source, and the editor follows the keyboard', async () => {
    const filter = container.querySelector<HTMLInputElement>('input[type="search"]')!
    await type(filter, 'launch qa')
    expect([...container.querySelectorAll('[data-resource-row] strong')].map(node => node.textContent)).toEqual(['Northwind client'])
    await type(filter, '')
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-resource-row]')]
    await act(async () => { rows[0]!.focus(); rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(container.querySelector('.browser-profile-editor__name')?.textContent).toBe('Northwind client')
  })
})

describe('Settings › Browser Profiles leads to the Browsers it describes', () => {
  const onClose = vi.fn()
  beforeEach(async () => {
    onClose.mockClear()
    await act(async () => root.render(<BrowserProfilesSettingsPane active onClose={onClose} />))
  })

  it('Show closes Settings and selects that exact Browser in its own Tab Group', async () => {
    await select('Northwind client')
    const saved = [...container.querySelectorAll<HTMLButtonElement>('.browser-profile-editor__use')].find(button => button.textContent?.includes('Release notes'))!
    await act(async () => { saved.click(); await new Promise(resolve => setTimeout(resolve, 40)) })
    expect(onClose).toHaveBeenCalledOnce()
    expect(store.selectMainRegion).toHaveBeenCalledExactlyOnceWith({ displayWorkspaceId: 'ws-1', groupId: 'g-2', tabId: 't2', regionId: 'b-saved' })
    expect(store.reportError).not.toHaveBeenCalled()
  })

  it('a Browser that can no longer be selected is said, not silently dropped', async () => {
    store.selectMainRegion.mockReturnValueOnce(false)
    await select('Northwind client')
    await act(async () => { container.querySelector<HTMLButtonElement>('.browser-profile-editor__use')!.click(); await new Promise(resolve => setTimeout(resolve, 40)) })
    expect(String(store.reportError.mock.calls[0]?.[0])).toContain('“Launch board” could not be shown')
  })

  it('Open Browser opens a normal Browser in exactly this Profile beside the current work', async () => {
    await select('Northwind client')
    await act(async () => { container.querySelector<HTMLButtonElement>('.browser-profile-editor__open')!.click(); await new Promise(resolve => setTimeout(resolve, 40)) })
    expect(onClose).toHaveBeenCalledOnce()
    expect(store.createBrowser).toHaveBeenCalledExactlyOnceWith('g-1', undefined, 'about:blank', undefined, 'ws-1', 'ws-1', 'normal', undefined, 'p-client')
  })
})

describe('Settings › Browser Profiles by keyboard', () => {
  // Radix roving focus moves focus on the next task, as in the app.
  const key = (target: Element, name: string) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)) })

  it('the color picker names each color, starts on the current choice, moves with arrows without saving, and Escape returns', async () => {
    const mark = container.querySelector<HTMLButtonElement>('.browser-profile-editor__mark')!
    await act(async () => mark.click())
    const group = container.querySelector('.browser-profile-editor__hues[role="radiogroup"]')!
    expect(group.getAttribute('aria-label')).toBe('Color for Personal')
    expect([...group.querySelectorAll('[role="radio"]')].map(radio => radio.getAttribute('aria-label'))).toEqual([...PROFILE_HUES.map(() => expect.any(String)), null])
    expect([...group.querySelectorAll('button[style]')].every(radio => !/^Hue \d+$/.test(radio.getAttribute('aria-label') ?? ''))).toBe(true)
    expect(document.activeElement?.textContent).toBe('Automatic')
    await key(document.activeElement!, 'ArrowRight')
    expect(document.activeElement).toBe(group.querySelector('button[style]'))
    expect(port.updateProfile).not.toHaveBeenCalled()
    await key(document.activeElement!, 'Escape')
    expect(container.querySelector('.browser-profile-editor__hues')).toBeNull()
    expect(document.activeElement).toBe(mark)
    expect(port.updateProfile).not.toHaveBeenCalled()
  })

  it('the delete confirmation takes focus on Cancel, and Escape closes it without deleting', async () => {
    store.tabs = {}
    await act(async () => root.render(<BrowserProfilesSettingsPane active />))
    await select('Northwind client')
    const more = container.querySelector<HTMLButtonElement>('[aria-label^="More for "]')!
    await act(async () => {
      more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
      more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.startsWith('Delete Profile'))!
    await act(async () => item.click())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const dialog = container.querySelector('[role="alertdialog"]')!
    expect(document.activeElement?.textContent).toBe('Cancel')
    await key(document.activeElement!, 'Escape')
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(dialog.isConnected).toBe(false)
    expect(port.deleteProfile).not.toHaveBeenCalled()
  })
})

describe('Settings › Browser Profiles clears one site', () => {
  const section = () => container.querySelector('[aria-label="Sites with sign-ins"]')!
  const button = (text: string) => [...section().querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)

  it('reads sites only when asked, confirms in place, and clears only the confirmed site', async () => {
    port.listProfileSites.mockClear(); port.clearProfileSite.mockClear()
    expect(port.listProfileSites).not.toHaveBeenCalled()
    await act(async () => button('Show sites')!.click())
    expect(port.listProfileSites).toHaveBeenCalledExactlyOnceWith('p-personal')
    expect([...section().querySelectorAll('li')].map(li => li.textContent)).toEqual(['github.com3 cookiesClear…', 'example.com1 cookieClear…'])

    await act(async () => section().querySelector<HTMLButtonElement>('[aria-label="Clear github.com"]')!.click())
    const confirm = section().querySelector('[role="alertdialog"]')!
    expect(confirm.textContent).toContain('Sign out of github.com and remove its site data in this Profile?')
    expect(document.activeElement?.textContent).toBe('Cancel')
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(section().querySelector('[role="alertdialog"]')).toBeNull()
    expect(port.clearProfileSite).not.toHaveBeenCalled()

    await act(async () => section().querySelector<HTMLButtonElement>('[aria-label="Clear github.com"]')!.click())
    await act(async () => section().querySelector<HTMLButtonElement>('[role="alertdialog"] .danger-button')!.click())
    expect(port.clearProfileSite).toHaveBeenCalledExactlyOnceWith('p-personal', 'github.com',
      { kind: 'user-confirmed', operation: 'clear-site-data', scope: 'profile-site', profileId: 'p-personal', site: 'github.com' })
    expect([...section().querySelectorAll('li')].map(li => li.textContent)).toEqual(['example.com1 cookieClear…'])
    expect(section().querySelector('[role="status"]')?.textContent).toBe('Signed out of github.com in Personal. Reload its open pages to see it.')
  })

  it('keeps the site and says why when clearing is refused', async () => {
    port.clearProfileSite.mockRejectedValueOnce(new Error('EBUSY'))
    await act(async () => button('Show sites')!.click())
    await act(async () => section().querySelector<HTMLButtonElement>('[aria-label="Clear example.com"]')!.click())
    await act(async () => section().querySelector<HTMLButtonElement>('[role="alertdialog"] .danger-button')!.click())
    expect([...section().querySelectorAll('li')].map(li => li.textContent)).toContain('example.com1 cookieClear…')
    expect(section().querySelector('[role="alert"]')?.textContent).toContain('example.com was not cleared.')
  })
})

describe('Settings › Browser Profiles Agents switch', () => {
  const agents = () => container.querySelector<HTMLInputElement>('[aria-label="Agents"] input[role="switch"]')!

  it('turns Agents off and on for this Profile with its configuration token', async () => {
    store.config.browser.agentAutomation = true
    await act(async () => root.render(<BrowserProfilesSettingsPane active />))
    expect(agents().checked).toBe(true)
    await act(async () => agents().click())
    expect(port.updateProfile).toHaveBeenLastCalledWith('p-personal', { agentAccess: false }, 'personal-token')
    expect(container.querySelector('[aria-label="Agents"] small')?.textContent).toContain('You can still run your own steps')
  })

  it('says when the global switch already keeps every Agent out', async () => {
    store.config.browser.agentAutomation = false
    await act(async () => root.render(<BrowserProfilesSettingsPane active />))
    expect(container.querySelector('[aria-label="Agents"] small')?.textContent).toContain('Agent browser automation is off in Settings › Browser')
    store.config.browser.agentAutomation = true
  })
})

describe('Settings › Browser Profiles exit check', () => {
  const section = () => container.querySelector('[aria-label="Exit check"]')!

  it('offers to set a check address when none is saved, and sends nothing', async () => {
    delete store.config.browser.exitCheckUrl
    await act(async () => root.render(<BrowserProfilesSettingsPane active />))
    expect(section().textContent).toContain('Follows the system proxy')
    expect([...section().querySelectorAll('button')].map(button => button.textContent)).toEqual(['Set a check address'])
    expect(port.checkProfileExit).not.toHaveBeenCalled()
  })

  it('checks this Profile through its route and shows the reached address, status and time', async () => {
    store.config.browser.exitCheckUrl = 'https://ip.example.test/'
    port.set({ revision: 4, sequence: 4, folders: [], views: [], profiles: [{ ...personal, network: { mode: 'proxy', server: { scheme: 'socks5', host: '10.0.0.2', port: 1080 } } }, client] })
    await act(async () => { await browserProfiles.refresh() })
    await act(async () => root.render(<BrowserProfilesSettingsPane active />))
    const check = [...section().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check')!
    await act(async () => check.click())
    expect(port.checkProfileExit).toHaveBeenCalledWith('p-personal')
    expect(section().textContent).toBe('Exit checksocks5://10.0.0.2:1080→ 203.0.113.7 · HTTP 200 · 184 msCheck again')
    delete store.config.browser.exitCheckUrl
  })

  it('says an unanswered check is unknown and keeps it repeatable', async () => {
    store.config.browser.exitCheckUrl = 'https://ip.example.test/'
    port.checkProfileExit.mockResolvedValueOnce({ status: 'unknown', reason: 'ERR_PROXY_CONNECTION_FAILED', latencyMs: 40 } as never)
    await act(async () => root.render(<BrowserProfilesSettingsPane active />))
    await act(async () => [...section().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check')!.click())
    expect(section().querySelector('[role="status"]')?.textContent).toBe('→ unknown · ERR_PROXY_CONNECTION_FAILED')
    expect([...section().querySelectorAll('button')].map(button => button.textContent)).toEqual(['Check again'])
    delete store.config.browser.exitCheckUrl
  })

  it('does not attribute an earlier or late check result to a changed route or check address', async () => {
    store.config.browser.exitCheckUrl = 'https://ip.example.test/'
    await act(async () => root.render(<BrowserProfilesSettingsPane active />))
    const check = () => [...section().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check')!
    await act(async () => check().click())
    expect(section().textContent).toContain('203.0.113.7')
    port.set({ revision: 5, sequence: 5, folders: [], views: [], profiles: [{ ...personal, network: { mode: 'direct' } }, client] })
    await act(async () => { await browserProfiles.refresh() })
    expect(section().textContent).toContain('Connects directly')
    expect(section().querySelector('[role="status"]')).toBeNull()
    let finishCheck!: (value: Awaited<ReturnType<typeof port.checkProfileExit>>) => void
    port.checkProfileExit.mockReturnValueOnce(new Promise(resolve => { finishCheck = resolve }))
    await act(async () => check().click())
    store.config.browser.exitCheckUrl = 'https://other.example.test/'
    await act(async () => root.render(<BrowserProfilesSettingsPane active />))
    await act(async () => finishCheck({ status: 'reachable', httpStatus: 200, latencyMs: 5, ip: '203.0.113.99' }))
    expect(section().querySelector('[role="status"]')).toBeNull()
    expect(check().disabled).toBe(false)
    delete store.config.browser.exitCheckUrl
  })
})

describe('Settings › Browser Profiles proxy sign-in', () => {
  const SENTINEL = 'S3NTINEL-pa55word'
  const section = () => container.querySelector('[aria-label="Proxy sign-in"]')
  const type = async (element: HTMLInputElement, value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  async function proxied() {
    port.set({ revision: 4, sequence: 4, folders: [], views: [], profiles: [{ ...personal, network: { mode: 'proxy', server: { scheme: 'http', host: 'gw.corp.test', port: 3128 } } }, client] })
    await act(async () => { await browserProfiles.refresh() })
    await act(async () => root.render(<BrowserProfilesSettingsPane active />))
    // The saved user name is read once on open; Add sign-in waits for that answer.
    await vi.waitFor(() => expect(section()?.textContent).not.toContain('Reading…'))
  }

  it('appears only for a Profile whose route is a proxy', async () => {
    expect(section()).toBeNull()
    await proxied()
    expect(section()?.textContent).toContain('No sign-in')
  })

  it('keeps a failed sign-in read unknown, allows setting it, and retries the same Profile', async () => {
    port.readProfileProxySignIn.mockRejectedValueOnce(new Error('The keychain could not be read.'))
    await proxied()
    expect(section()?.textContent).toContain('Sign-in unknown')
    expect(section()?.textContent).not.toContain('No sign-in')
    expect(section()?.querySelector('[role="status"]')?.textContent).toContain('The keychain could not be read.')
    const setSignIn = [...section()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Set sign-in')!
    expect(setSignIn.disabled).toBe(false)
    port.readProfileProxySignIn.mockResolvedValueOnce({ username: 'alice' })
    await act(async () => [...section()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!.click())
    expect(port.readProfileProxySignIn).toHaveBeenLastCalledWith('p-personal')
    expect(section()?.textContent).toContain('Signs in as alice')
    expect(section()?.querySelector('[role="status"]')).toBeNull()
  })

  it('keeps a newer sign-in save when the original read finishes late', async () => {
    let resolveRead!: (value: { username: string } | null) => void
    port.readProfileProxySignIn.mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve }))
    port.set({ revision: 4, sequence: 4, folders: [], views: [], profiles: [{ ...personal, network: { mode: 'proxy', server: { scheme: 'http', host: 'gw.corp.test', port: 3128 } } }, client] })
    await act(async () => { await browserProfiles.refresh() })
    await act(async () => [...section()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Set sign-in')!.click())
    await type(section()!.querySelector<HTMLInputElement>('input[aria-label="Proxy user name"]')!, 'alice')
    await type(section()!.querySelector<HTMLInputElement>('input[aria-label="Proxy password"]')!, SENTINEL)
    await act(async () => section()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    await act(async () => resolveRead(null))
    expect(section()?.textContent).toContain('Signs in as alice')
    expect(section()?.textContent).not.toContain('No sign-in')
  })

  it('sends the password to Main once, then shows only the user name and an empty field', async () => {
    await proxied()
    await act(async () => [...section()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Add sign-in')!.click())
    await type(section()!.querySelector<HTMLInputElement>('input[aria-label="Proxy user name"]')!, 'alice')
    await type(section()!.querySelector<HTMLInputElement>('input[aria-label="Proxy password"]')!, SENTINEL)
    await act(async () => section()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(port.setProfileProxySignIn).toHaveBeenCalledExactlyOnceWith('p-personal', { username: 'alice', password: SENTINEL })
    expect(section()!.textContent).toContain('Signs in as alice')
    expect(container.innerHTML).not.toContain(SENTINEL)
    await act(async () => [...section()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Change')!.click())
    expect(section()!.querySelector<HTMLInputElement>('input[aria-label="Proxy password"]')!.value, 'the password is never put back into the field').toBe('')
  })

  it('a refused save says why and clears the typed password', async () => {
    port.setProfileProxySignIn.mockRejectedValueOnce(Object.assign(new Error('The system keychain is not available, so a proxy password cannot be kept.'), { code: 'BROWSER_PROFILE_PROXY_AUTH_UNAVAILABLE' }))
    await proxied()
    await act(async () => [...section()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Add sign-in')!.click())
    await type(section()!.querySelector<HTMLInputElement>('input[aria-label="Proxy user name"]')!, 'alice')
    await type(section()!.querySelector<HTMLInputElement>('input[aria-label="Proxy password"]')!, SENTINEL)
    await act(async () => section()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(section()!.querySelector('[role="alert"]')?.textContent).toContain('keychain is not available')
    expect(section()!.querySelector<HTMLInputElement>('input[aria-label="Proxy password"]')!.value).toBe('')
    expect(container.innerHTML).not.toContain(SENTINEL)
  })

  it('reports a confirmed save separately from an unconfirmed connection update', async () => {
    await proxied()
    port.setProfileProxySignIn.mockResolvedValueOnce({ reconnected: false })
    await act(async () => [...section()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Add sign-in')!.click())
    await type(section()!.querySelector<HTMLInputElement>('input[aria-label="Proxy user name"]')!, 'alice')
    await type(section()!.querySelector<HTMLInputElement>('input[aria-label="Proxy password"]')!, SENTINEL)
    await act(async () => section()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(section()?.textContent).toContain('Signs in as alice')
    expect(section()?.querySelector('[role="status"]')?.textContent).toContain('Sign-in saved. Open connections could not be updated.')
    expect(section()?.querySelector('[role="alert"]')).toBeNull()
    expect(container.innerHTML).not.toContain(SENTINEL)
    expect([...section()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Change')!.disabled).toBe(false)
  })
})
