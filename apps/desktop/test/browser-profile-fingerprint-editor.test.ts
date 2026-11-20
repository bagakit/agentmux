// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserProfileSummary } from '../src/shared/contracts'
import type { BrowserProfileEnvironment } from '@agentmux/core/control'

const port = vi.hoisted(() => ({ update: vi.fn(), refresh: vi.fn(), flush: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({
  api: { browser: { updateProfile: port.update }, ui: { requestStorageFlush: port.flush } }
}))
vi.mock('../src/renderer/src/lib/browser-profiles', () => ({ browserProfiles: { refresh: port.refresh } }))
import { ProfileEnvironmentEditor } from '../src/renderer/src/components/settings/ProfileEnvironmentEditor'
import {
  environmentFields,
  environmentFromFields,
  parseEnvironmentDraft
} from '../src/renderer/src/lib/browser-profile-environment-form'
import { profileEnvironmentDrafts } from '../src/renderer/src/lib/browser-profile-environment-drafts'

const profile: BrowserProfileSummary = {
  id: 'profile-a',
  revision: 'profile-token-a',
  label: 'Work',
  createdAt: 1,
  isDefault: true,
  source: null
}
const all: BrowserProfileEnvironment = {
  userAgent: 'Profile/1.0',
  acceptLanguages: ['fr-FR', 'en'],
  timeZone: 'Europe/Paris',
  locale: 'fr-FR',
  geolocation: { latitude: 12.3, longitude: -56.7, accuracy: 0 },
  screen: { width: 1440, height: 900 },
  hardwareConcurrency: 3,
  userAgentMetadata: {
    platform: 'SampleOS',
    platformVersion: '1',
    architecture: 'arm',
    model: '',
    mobile: false,
    bitness: '',
    wow64: false,
    brands: [],
    fullVersionList: [{ brand: 'Profile', version: '1.0' }]
  }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
let root: Root, container: HTMLDivElement
const input = (name: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
const button = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((value) => value.textContent === text)!
async function render(value = profile) {
  await act(async () => root.render(createElement(ProfileEnvironmentEditor, { profile: value })))
}
async function type(name: string, value: string) {
  await act(async () => {
    const field = input(name)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function click(text: string) {
  expect(button(text), text).toBeDefined()
  await act(async () => button(text).click())
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  port.update.mockReset()
  port.refresh.mockReset()
  port.flush.mockReset()
  port.flush.mockResolvedValue(undefined)
  port.refresh.mockResolvedValue(undefined)
  port.update.mockImplementation(async (id, edit) => ({
    ...profile,
    id,
    revision: 'saved-token',
    environment: edit.environment ?? undefined
  }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Profile environment editor on the original update API', () => {
  it('round trips every supported field and distinguishes optional defaults from explicit empty/false', () => {
    // A real sandbox Renderer has no Node Buffer, unlike the happy-dom host.
    vi.stubGlobal('Buffer', undefined)
    expect(environmentFromFields(environmentFields(all))).toEqual(all)
    expect(environmentFromFields(environmentFields())).toBeNull()
    const fields = environmentFields(all)
    fields.timeZone = 'incomplete/'
    const draft = { baseRevision: 'original-token', fields }
    expect(parseEnvironmentDraft(draft)).toEqual(draft)
    expect(() => environmentFromFields(fields)).toThrow()
    expect(fields.timeZone).toBe('incomplete/')
  })

  it('submits all engine parameters with the selected Profile token and clears only the confirmed draft', async () => {
    await render({ ...profile, environment: all })
    await type('Time zone', 'Pacific/Honolulu')
    await click('Apply environment')
    expect(port.update).toHaveBeenCalledWith(
      profile.id,
      { environment: { ...all, timeZone: 'Pacific/Honolulu' } },
      profile.revision
    )
    expect(container.textContent).toContain('Settings saved.')
    expect(button('Apply environment')).toBeUndefined()
    expect(profileEnvironmentDrafts.get(profile.id)?.active).toBeUndefined()
  })

  it('retains invalid raw input across remount and keeps it isolated by Profile', async () => {
    await render()
    await type('Time zone', 'Unfinished/')
    expect(button('Apply environment').disabled).toBe(true)
    await act(async () => root.unmount())
    root = createRoot(container)
    await render({ ...profile, id: 'profile-b' })
    expect(input('Time zone').value).toBe('')
    await render()
    expect(input('Time zone').value).toBe('Unfinished/')
    expect(port.update).not.toHaveBeenCalled()
  })

  it('edits structured client-hint brands through the real controls without dropping optional false or empty values', async () => {
    await render({ ...profile, environment: all })
    await click('Add brand'); await type('Brands brand 1', 'Edited browser'); await type('Brands version 1', '2')
    await click('Apply environment')
    expect(port.update).toHaveBeenCalledWith(profile.id, { environment: { ...all, userAgentMetadata: {
      ...all.userAgentMetadata!, brands: [{ brand: 'Edited browser', version: '2' }]
    } } }, profile.revision)
  })

  it('presents native application values as coordinates, screen dimensions and readable client hints', async () => {
    await render({ ...profile, environment: all, environmentApplication: { status: 'applied', scope: 'session-defaults', unsupported: [], pages: [{ browserId: 'original-browser', status: 'applied',
      fields: { geolocation: { status: 'applied', scope: 'page-target' }, screen: { status: 'applied', scope: 'page-target' }, userAgentMetadata: { status: 'applied', scope: 'page-target' } },
      scope: { currentDocument: 'applied', futureNavigation: 'applied', subdocuments: 'unknown', workers: 'unknown', initialScripts: 'unknown' }
    }] } })
    const text = container.querySelector('.profile-environment__page')!.textContent
    expect(text).toContain('12.3°, -56.7° · accuracy 0 m')
    expect(text).toContain('1440 × 900')
    expect(text).toContain('SampleOS 1 · arm · Desktop')
    expect(text).toContain('Client hint details')
    expect(text).not.toContain('"platformVersion"')
  })

  it('restores engine defaults only after the explicit original Profile save', async () => {
    await render({ ...profile, environment: all })
    await click('Restore defaults')
    expect(input('Time zone').value).toBe('')
    expect(port.update).not.toHaveBeenCalled()
    await click('Apply environment')
    expect(port.update).toHaveBeenCalledWith(profile.id, { environment: null }, profile.revision)
  })

  it('a late save ACK preserves newer input and rebases its next explicit save onto that receipt', async () => {
    const pending = deferred<BrowserProfileSummary>()
    port.update.mockReturnValueOnce(pending.promise)
    await render()
    await type('Time zone', 'Europe/Paris')
    await click('Apply environment')
    await type('Time zone', 'Asia/Tokyo')
    await act(async () =>
      pending.resolve({ ...profile, revision: 'first-save-token', environment: { timeZone: 'Europe/Paris' } })
    )
    expect(input('Time zone').value).toBe('Asia/Tokyo')
    expect(container.textContent).toContain('Earlier settings saved. You have new edits.')
    expect(profileEnvironmentDrafts.get(profile.id)?.active).toMatchObject({
      baseRevision: 'first-save-token',
      fields: { timeZone: 'Asia/Tokyo' }
    })
    await click('Apply environment')
    expect(port.update).toHaveBeenLastCalledWith(
      profile.id,
      { environment: { timeZone: 'Asia/Tokyo' } },
      'first-save-token'
    )
  })

  it('does not erase edits on a failed save or automatically replay a revision conflict', async () => {
    port.update.mockRejectedValueOnce(
      Object.assign(new Error('Profile configuration changed; read current settings.'), {
        code: 'BROWSER_PROFILE_REVISION_CONFLICT'
      })
    )
    await render()
    await type('Time zone', 'Europe/Paris')
    await click('Apply environment')
    expect(input('Time zone').value).toBe('Europe/Paris')
    expect(port.update).toHaveBeenCalledTimes(1)
    await render({ ...profile, revision: 'external-token', environment: { locale: 'de-DE' } })
    expect(input('Time zone').value).toBe('Europe/Paris')
    await click('Keep edits with current version')
    await click('Apply environment')
    expect(port.update).toHaveBeenLastCalledWith(
      profile.id,
      { environment: { timeZone: 'Europe/Paris' } },
      'external-token'
    )
  })

  it('keeps healthy Apply available when draft read is unconfirmed, then retains the prior disk input on retry', async () => {
    const previous = {
      baseRevision: 'older-token',
      fields: { ...environmentFields(), timeZone: 'Asia/Tokyo' }
    }
    profileEnvironmentDrafts.write(profile.id, previous)
    const load = vi
      .spyOn(profileEnvironmentDrafts, 'load')
      .mockRejectedValueOnce(new Error('EACCES reading original drafts'))
    const write = vi.spyOn(profileEnvironmentDrafts, 'write').mockImplementationOnce(() => {
      throw new Error('Draft owner not ready')
    })
    await render()
    await type('Time zone', 'Europe/Paris')
    expect(button('Apply environment').disabled).toBe(false)
    expect(container.textContent).toContain('Draft storage unconfirmed')
    await click('Retry draft storage')
    expect(input('Time zone').value).toBe('Europe/Paris')
    expect(profileEnvironmentDrafts.get(profile.id)?.retained).toEqual([previous])
    await click('Restore draft 1')
    expect(input('Time zone').value).toBe('Asia/Tokyo')
    expect(profileEnvironmentDrafts.get(profile.id)?.retained[0]?.fields.timeZone).toBe('Europe/Paris')
    expect(load).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalled()
  })

  it('a delayed draft read cannot overwrite typing, or resurrect an old draft after a successful Apply', async () => {
    profileEnvironmentDrafts.write(profile.id, {
      baseRevision: 'disk-token',
      fields: { ...environmentFields(), timeZone: 'Asia/Tokyo' }
    })
    const pending = deferred<void>()
    vi.spyOn(profileEnvironmentDrafts, 'load').mockReturnValueOnce(pending.promise)
    await render()
    await type('Time zone', 'Europe/Paris')
    await click('Apply environment')
    await act(async () => pending.resolve())
    expect(input('Time zone').value).toBe('Europe/Paris')
    expect(button('Apply environment')).toBeUndefined()
    expect(container.textContent).toContain('Settings saved.')
  })

  it('keeps successful configuration separate from unconfirmed draft cleanup', async () => {
    await render()
    await type('Time zone', 'Europe/Paris')
    port.flush.mockRejectedValueOnce(new Error('Draft write ACK lost'))
    await click('Apply environment')
    expect(port.update).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Settings saved.')
    expect(container.textContent).toContain('Draft write ACK lost')
    expect(button('Apply environment')).toBeUndefined()
  })

  it('does not clear a draft write failure until the explicit retry receives the original storage ACK', async () => {
    await render(); await type('Time zone', 'Europe/Paris')
    await act(async () => window.dispatchEvent(new Event('agentmux-workbench-save-error')))
    const pending = deferred<void>(); port.flush.mockReturnValueOnce(pending.promise)
    await click('Retry draft storage')
    expect(container.textContent).toContain('Draft storage unconfirmed')
    expect(button('Apply environment').disabled).toBe(false)
    await act(async () => pending.resolve())
    expect(container.textContent).not.toContain('Draft storage unconfirmed')
    expect(input('Time zone').value).toBe('Europe/Paris')
  })

  it('uses live native application receipts and re-applies saved settings without sending the input draft', async () => {
    const current: BrowserProfileSummary = {
      ...profile,
      environment: { locale: 'fr-FR' },
      environmentApplication: {
        status: 'unknown',
        scope: 'session-defaults',
        unsupported: [],
        reason: 'Native settings unconfirmed'
      }
    }
    await render(current)
    await type('Time zone', 'Europe/Paris')
    expect(container.textContent).toContain('Application unconfirmed')
    await click('Reapply saved settings')
    expect(port.update).toHaveBeenCalledWith(
      profile.id,
      { environment: { locale: 'fr-FR' } },
      profile.revision
    )
    expect(input('Time zone').value).toBe('Europe/Paris')
    await render({
      ...current,
      environmentApplication: {
        status: 'applied',
        scope: 'session-defaults',
        unsupported: [],
        pages: [
          {
            browserId: 'original-browser',
            status: 'applied',
            fields: { locale: { status: 'applied', scope: 'page-target' } },
            scope: {
              currentDocument: 'applied',
              futureNavigation: 'applied',
              subdocuments: 'unknown',
              workers: 'unknown',
              initialScripts: 'unknown'
            }
          }
        ]
      }
    })
    expect(container.textContent).toContain('Applied to 1 Browser')
    expect(container.textContent).toContain('First-script, subdocument and Worker coverage is unconfirmed')
    expect(container.textContent).toContain(
      'TLS, device memory and engine-wide fingerprint overrides are unsupported'
    )
    await click('Apply environment')
    expect(port.update).toHaveBeenLastCalledWith(profile.id,
      { environment: { locale: 'fr-FR', timeZone: 'Europe/Paris' } }, 'saved-token')
  })
})
