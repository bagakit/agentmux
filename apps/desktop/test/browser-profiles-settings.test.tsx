// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserProfileList, BrowserProfileSummary } from '../src/shared/contracts'

const port = vi.hoisted(() => {
  const listeners = new Set<(list: BrowserProfileList) => void>()
  let list: BrowserProfileList = { revision: 0, profiles: [] }
  const commit = (next: BrowserProfileSummary[]) => { list = { revision: list.revision + 1, profiles: next }; for (const listener of listeners) listener(list) }
  return {
    listeners, set(next: BrowserProfileList) { list = next }, get: () => list, commit,
    readProfiles: vi.fn(async () => list),
    onProfilesChanged: vi.fn((listener: (list: BrowserProfileList) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    updateProfile: vi.fn(async (id: string, edit: { label?: string; hue?: number | null; notes?: string }, expected: number) => {
      if (expected !== list.revision) throw Object.assign(new Error('Browser Profiles changed since revision was read; current revision is ' + list.revision + '. Read them again and retry.'), { code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
      const next = list.profiles.map(profile => {
        if (profile.id !== id) return profile
        const updated: BrowserProfileSummary = { ...profile, ...(edit.label === undefined ? {} : { label: edit.label }) }
        if (edit.hue === null) delete updated.hue; else if (edit.hue !== undefined) updated.hue = edit.hue
        if (edit.notes !== undefined) { if (edit.notes) updated.notes = edit.notes; else delete updated.notes }
        return updated
      })
      commit(next)
      return next.find(profile => profile.id === id)!
    }),
    setDefaultProfile: vi.fn(async () => {}),
    createProfile: vi.fn(async (label: string) => { const created = { id: 'p-new', label, createdAt: 3, isDefault: false, source: null }; commit([...list.profiles, created]); return created }),
    deleteProfile: vi.fn(async () => {}),
    detectProfileImportSources: vi.fn(async () => []),
    importProfile: vi.fn()
  }
})
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: port } }))
const store = vi.hoisted(() => ({ tabs: {} as Record<string, unknown> }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: (select: (state: typeof store) => unknown) => select(store) }))

import { browserProfiles } from '../src/renderer/src/lib/browser-profiles'
import { BrowserProfilesSettingsPane, PROFILE_HUES } from '../src/renderer/src/components/settings/BrowserProfilesSettingsPane'
import { clearsSemanticHues } from '../src/renderer/src/lib/conversation-avatar-color'

const personal: BrowserProfileSummary = { id: 'p-personal', label: 'Personal', createdAt: 1, isDefault: true, source: null }
const client: BrowserProfileSummary = { id: 'p-client', label: 'Northwind client', createdAt: 2, isDefault: false, source: null, notes: 'Launch QA' }

function browserTab(id: string, profileId: string, deferred: boolean) {
  return { regions: { [id]: { kind: 'browser', browserId: id, profileId, title: id === 'b-open' ? 'Launch board' : 'Release notes', url: 'https://app.example/', ...(deferred ? { nativeOwnerDeferred: true } : {}) } } }
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
  browserProfiles.reset(); port.listeners.clear()
  for (const fn of [port.readProfiles, port.updateProfile, port.setDefaultProfile, port.createProfile, port.deleteProfile]) fn.mockClear()
  port.set({ revision: 4, profiles: [personal, client] })
  store.tabs = { t1: browserTab('b-open', 'p-client', false), t2: browserTab('b-saved', 'p-client', true) }
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

  it('renames in place with the list revision and shows the saved name everywhere', async () => {
    await select('Northwind client')
    await act(async () => $<HTMLButtonElement>('.browser-profile-editor__name')!.click())
    const input = $<HTMLInputElement>('input[aria-label="Profile name"]')!
    expect(document.activeElement).toBe(input)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Northwind QA'); input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(port.updateProfile).toHaveBeenCalledExactlyOnceWith('p-client', { label: 'Northwind QA' }, 4)
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
    expect(port.updateProfile).toHaveBeenLastCalledWith('p-personal', { hue: PROFILE_HUES[1] }, 4)
    await act(async () => $<HTMLButtonElement>('.browser-profile-editor__mark')!.click())
    await act(async () => $<HTMLButtonElement>('.browser-profile-editor__auto')!.click())
    expect(port.updateProfile).toHaveBeenLastCalledWith('p-personal', { hue: null }, 5)
  })

  it('lists live and not-yet-loaded Browsers as in use and never offers to delete that Profile', async () => {
    await select('Northwind client')
    const uses = [...container.querySelectorAll('.browser-profile-editor__uses li')].map(li => li.textContent)
    expect(uses).toEqual(['Launch boardOpen', 'Release notesNot loaded yet'])
    expect($('.browser-profile-editor__who small')?.textContent).toContain('Open in 1 Browser')
  })

  it('a refused edit keeps the editor usable and offers Reload for a changed list', async () => {
    port.set({ revision: 9, profiles: [personal, client] })
    await act(async () => $<HTMLButtonElement>('.browser-profile-editor__note')!.click())
    const notes = $<HTMLTextAreaElement>('textarea[aria-label="Notes"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(notes, 'Personal sign-ins')
      notes.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => notes.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(port.updateProfile).toHaveBeenCalledWith('p-personal', { notes: 'Personal sign-ins' }, 4)
    expect($('[role="alert"]')?.textContent).toContain('changed since')
    const reload = [...container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find(button => button.textContent === 'Reload')!
    await act(async () => reload.click())
    expect(port.readProfiles).toHaveBeenCalledTimes(2)
    expect($<HTMLButtonElement>('button.small-button')!.disabled).toBe(false)
  })

  it('a failed refresh keeps the last list and every action available', async () => {
    port.readProfiles.mockRejectedValueOnce(new Error('EACCES'))
    await act(async () => { await browserProfiles.refresh() })
    expect($('.browser-profiles-settings__service')?.textContent).toContain('showing the last list')
    expect(container.querySelectorAll('[data-resource-row]')).toHaveLength(2)
    expect([...container.querySelectorAll<HTMLButtonElement>('.settings-pane-toolbar button')].every(button => !button.disabled)).toBe(true)
  })

  it('New Profile opens straight into naming the new Profile', async () => {
    const create = [...container.querySelectorAll<HTMLButtonElement>('.settings-pane-toolbar button')].find(button => button.textContent?.includes('New Profile'))!
    await act(async () => create.click())
    expect(port.createProfile).toHaveBeenCalledWith('Profile 3')
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
