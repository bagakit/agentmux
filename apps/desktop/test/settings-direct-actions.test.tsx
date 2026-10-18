// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { BrowserStartPage } from '../src/renderer/src/components/BrowserStartPage'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { DEFAULT_BROWSER_START_PAGE } from '../src/shared/browser-start-page'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import type { AgentMuxRpcResult } from '@agentmux/core'

const dom = composerDOM()
const originalImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const selectedImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
beforeEach(() => useAppStore.setState({ config: composerConfig, loading: false }))
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = dom.container.querySelector<T>(selector)
  expect(found, selector).not.toBeNull()
  return found!
}
async function button(label: string) {
  const found = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
  expect(found, label).toBeDefined()
  await act(async () => found!.click())
}
async function input(label: string, value: string) {
  const field = node<HTMLInputElement>(`[aria-label="${label}"]`)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function choose(kind: 'icon' | 'background', file?: File) {
  const field = node<HTMLInputElement>(`[aria-label="Select ${kind} image file"]`)
  Object.defineProperty(field, 'files', { configurable: true, value: file ? [file] : [] })
  await act(async () => {
    field.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  if (file && !vi.isMockFunction(FileReader.prototype.readAsDataURL)) await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(node(`[data-settings-field="start-${kind}"]`).textContent).not.toContain('Reading image')
  })
}
function imageFile(data = selectedImage) {
  return new File([Uint8Array.from(atob(data.split(',')[1]!), char => char.charCodeAt(0))], 'selected.png', { type: 'image/png' })
}
function controlledReads() {
  const reads: FileReader[] = []
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) { reads.push(this) })
  return {
    async finish(index: number, value: string) {
      const reader = reads[index]!
      expect(reader).toBeDefined()
      Object.defineProperty(reader, 'result', { configurable: true, value })
      await act(async () => reader.dispatchEvent(new Event('load')))
    },
    async fail(index: number) { await act(async () => reads[index]!.dispatchEvent(new Event('error'))) }
  }
}

it('Survey selects, replaces and clears images through the original save owner and actual start-page consumer', async () => {
  const before = { ...DEFAULT_BROWSER_START_PAGE, icon: originalImage }
  const fixture = await configOwnerFixture({ browser: { ...composerConfig.browser, startPage: before } })
  useAppStore.setState({ config: fixture.owner.current })
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (value, expected) => {
    await fixture.owner.edit(expected!, value)
    useAppStore.setState({ config: fixture.owner.current })
    return fixture.owner.current
  })
  await dom.render(<SettingsPanel initialSection="survey" onClose={() => {}} />)
  expect(node<HTMLInputElement>('[aria-label="Start page icon"]').value).toBe('')
  expect(node<HTMLDetailsElement>('[data-settings-field="start-icon"] details').open).toBe(false)
  await choose('icon')
  expect(node<HTMLImageElement>('.settings-survey__icon').src).toBe(originalImage)
  await choose('icon', imageFile())
  expect(node<HTMLImageElement>('.settings-survey__icon').src).toBe(selectedImage)
  await choose('background', imageFile(originalImage))
  expect(node<HTMLImageElement>('.settings-survey__background').src).toBe(originalImage)
  expect(dom.container.textContent).not.toContain('base64')
  expect([...dom.container.querySelectorAll<HTMLInputElement>('input')].some(field => field.value.startsWith('data:'))).toBe(false)
  await dom.click('[aria-label="Clear icon image"]')
  expect(dom.container.querySelector('.settings-survey__icon')).toBeNull()
  expect(document.activeElement).toBe(node('[aria-label="Choose icon image"]'))
  await dom.click('nav [data-settings-target="overview"]'); await dom.click('nav [data-settings-target="survey"]')
  expect(dom.container.querySelector('.settings-survey__icon')).toBeNull()
  expect(node<HTMLImageElement>('.settings-survey__background').src).toBe(originalImage)
  expect(save).not.toHaveBeenCalled()
  await button('Save start page')
  expect(save).toHaveBeenCalledOnce()
  await act(async () => { await vi.waitFor(() => expect(fixture.publish).toHaveBeenCalledOnce()) })
  expect(save.mock.calls[0]![1]!.browser.startPage).toEqual(before)
  const saved = (await fixture.disk()).browser.startPage!
  expect(saved).toEqual({ ...before, icon: '', backgroundImage: originalImage })
  await dom.render(<BrowserStartPage config={saved} historyTarget={null} onChooseHistory={() => {}}>{null}</BrowserStartPage>)
  expect(dom.container.querySelector('.browser-start-page__icon')).toBeNull()
  expect(node<HTMLImageElement>('.browser-start-page__background').src).toBe(originalImage)
})

it('Survey keeps the current image after a failed read and prevents late reads replacing a clear or newer selection', async () => {
  useAppStore.setState({ config: { ...composerConfig, browser: { ...composerConfig.browser, startPage: { ...DEFAULT_BROWSER_START_PAGE, icon: originalImage } } } })
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(composerConfig)
  const reads = controlledReads()
  await dom.render(<SettingsPanel initialSection="survey" onClose={() => {}} />)
  await choose('icon', imageFile()); await reads.fail(0)
  expect(node<HTMLImageElement>('.settings-survey__icon').src).toBe(originalImage)
  expect(node('[data-settings-field="start-icon"] [role="status"]').textContent).toContain('current image is kept')
  await choose('icon', imageFile()); await dom.click('[aria-label="Clear icon image"]'); await reads.finish(1, selectedImage)
  expect(dom.container.querySelector('.settings-survey__icon')).toBeNull()
  await choose('icon', imageFile()); await choose('icon', imageFile(originalImage))
  await reads.finish(3, originalImage); await reads.finish(2, selectedImage)
  expect(node<HTMLImageElement>('.settings-survey__icon').src).toBe(originalImage)
  expect(save).not.toHaveBeenCalled()
})

it('Survey URL entry preserves explicit preview, failed-image retry and the original invalid draft', async () => {
  const save = vi.spyOn(api.config, 'save').mockResolvedValue(composerConfig)
  await dom.render(<SettingsPanel initialSection="survey" onClose={() => {}} />)
  await dom.click('[data-settings-field="start-icon"] details > summary')
  const source = 'https://images.example.test/research.png'
  await input('Start page icon', source)
  expect(dom.container.querySelector('[data-settings-field="start-icon"] img')).toBeNull()
  expect(dom.container.querySelector('.settings-survey__icon')).toBeNull()
  await button('Preview images')
  const image = node<HTMLImageElement>('.settings-survey__icon')
  expect(image.src).toBe(source); expect(image.referrerPolicy).toBe('no-referrer')
  await act(async () => image.dispatchEvent(new Event('error')))
  expect(image.hidden).toBe(true)
  expect(node<HTMLInputElement>('[aria-label="Start page icon"]').value).toBe(source)
  await button('Preview images')
  expect(node<HTMLImageElement>('.settings-survey__icon')).not.toBe(image)
  await input('Start page icon', 'invalid-image')
  await button('Preview images')
  expect(dom.container.querySelector('.settings-survey__icon')).toBeNull()
  expect(node('.settings-survey__image-notice').textContent).toContain('Your draft is kept')
  expect(node<HTMLInputElement>('[aria-label="Start page icon"]').value).toBe('invalid-image')
  expect(save).not.toHaveBeenCalled()
})

const connectionUrl = 'https://relay.example.test/connect#offer=original-host-offer'
function devices() {
  return vi.spyOn(api.deviceManagement, 'ls').mockResolvedValue({ hostId: 'original-host',
    mobileAccess: { state: 'connected', message: 'Ready' }, devices: [] })
}

it('Mobile offers scanning independently of clipboard or device observation and copies the exact displayed link', async () => {
  devices().mockRejectedValue(new Error('Device observation is unavailable'))
  const link = vi.spyOn(api.deviceManagement, 'link').mockResolvedValue({ hostId: 'original-host', url: connectionUrl })
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const revoke = vi.spyOn(api.deviceManagement, 'revoke')
  await dom.render(<SettingsPanel initialSection="mobile" onClose={() => {}} />)
  expect(node('[data-device-action="scan"]').textContent).toBe('Scan to connect')
  expect(node('[data-device-action="copy"]').textContent).toBe('Copy connection link')
  expect(link).not.toHaveBeenCalled()
  await dom.click('[data-device-action="scan"]')
  expect(link).toHaveBeenCalledExactlyOnceWith({})
  expect(clipboard).not.toHaveBeenCalled()
  expect(node('.connection-link-code svg title').textContent).toBe('Phone connection QR code')
  expect(node<HTMLTextAreaElement>('[aria-label="Phone connection link"]').value).toBe(connectionUrl)
  expect(node('.device-management__read-issue').textContent).toContain('Device status unavailable')
  await dom.click('[data-device-action="copy"]')
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(connectionUrl)
  expect(link).toHaveBeenCalledOnce()
  const refreshed = connectionUrl + '-refreshed'
  link.mockResolvedValueOnce({ hostId: 'original-host', url: refreshed })
  expect(node('[data-device-action="scan"]').textContent).toBe('Refresh code')
  await dom.click('[data-device-action="scan"]')
  expect(node<HTMLTextAreaElement>('[aria-label="Phone connection link"]').value).toBe(refreshed)
  await dom.click('[data-device-action="copy"]')
  expect(clipboard).toHaveBeenLastCalledWith(refreshed)
  expect(link).toHaveBeenCalledTimes(2)
  expect(revoke).not.toHaveBeenCalled()
})

it('Mobile can copy first and keeps the original QR and full link available after clipboard failure', async () => {
  devices()
  const link = vi.spyOn(api.deviceManagement, 'link').mockResolvedValue({ hostId: 'original-host', url: connectionUrl })
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValueOnce(new Error('Clipboard unavailable')).mockResolvedValue(undefined)
  await dom.render(<SettingsPanel initialSection="mobile" onClose={() => {}} />)
  await dom.click('[data-device-action="copy"]')
  expect(link).toHaveBeenCalledExactlyOnceWith({})
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(connectionUrl)
  expect(node('.device-management__feedback').textContent).toContain('Scan the code or select the full link')
  expect(node('.connection-link-code svg')).toBeDefined()
  expect(node<HTMLTextAreaElement>('[aria-label="Phone connection link"]').value).toBe(connectionUrl)
  await dom.click('.device-management__link > summary')
  await act(async () => node<HTMLTextAreaElement>('[aria-label="Phone connection link"]').focus())
  const full = node<HTMLTextAreaElement>('[aria-label="Phone connection link"]')
  expect([full.selectionStart, full.selectionEnd]).toEqual([0, connectionUrl.length])
  await dom.click('[data-device-action="copy"]')
  expect(node('.device-management__feedback').textContent).toContain('Link copied')
  expect(link).toHaveBeenCalledOnce()
})

it('Mobile ignores a departed link read and retains the same original device record after refresh failure', async () => {
  const read = devices().mockResolvedValue({ hostId: 'original-host', mobileAccess: { state: 'connected', message: 'Ready' },
    devices: [{ deviceId: 'original-phone', name: 'Personal phone', createdAt: 0, online: true }] })
  let finish!: (value: AgentMuxRpcResult<'device.link'>) => void
  const link = vi.spyOn(api.deviceManagement, 'link').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await dom.render(<SettingsPanel initialSection="mobile" onClose={() => {}} />)
  const record = node<HTMLDetailsElement>('[data-device-record="original-phone"]')
  record.open = true
  read.mockRejectedValueOnce(new Error('Refresh unavailable'))
  await button('Refresh')
  expect(node('[data-device-record="original-phone"]')).toBe(record)
  expect(record.open).toBe(true)
  await dom.click('[data-device-action="copy"]')
  await dom.click('nav [data-settings-target="overview"]')
  await act(async () => finish({ hostId: 'original-host', url: connectionUrl }))
  await dom.click('nav [data-settings-target="mobile"]')
  expect(dom.container.querySelector('.connection-link-code')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Phone connection link"]')).toBeNull()
  expect(clipboard).not.toHaveBeenCalled()
  link.mockResolvedValueOnce({ hostId: 'original-host', url: connectionUrl })
  await dom.click('[data-device-action="scan"]')
  expect(node('.connection-link-code svg')).toBeDefined()
})
