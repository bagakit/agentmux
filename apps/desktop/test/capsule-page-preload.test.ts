// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isObjectId } from '@agentmux/core/object-id'
import type { CapsulePageSdk, CapsulePageTheme } from '../src/shared/capsule-document'

const wire = vi.hoisted(() => ({ api: null as CapsulePageSdk | null, invoke: vi.fn(),
  events: new Map<string, (...args: any[]) => void>() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (name: string, api: CapsulePageSdk) => {
  expect(name).toBe('capsule'); wire.api = api
} }, ipcRenderer: { invoke: wire.invoke, on: (name: string, listener: (...args: any[]) => void) => wire.events.set(name, listener) } }))

const originalMainFrame = Object.getOwnPropertyDescriptor(process, 'isMainFrame')
beforeEach(() => {
  vi.resetModules(); wire.api = null; wire.events.clear(); wire.invoke.mockReset()
  wire.invoke.mockResolvedValue({ ok: true, value: null })
  Object.defineProperty(process, 'isMainFrame', { configurable: true, value: true })
  document.documentElement.removeAttribute('style')
})
afterEach(() => {
  if (originalMainFrame) Object.defineProperty(process, 'isMainFrame', originalMainFrame)
  else delete (process as NodeJS.Process & { isMainFrame?: boolean }).isMainFrame
})

it('exposes only the narrow Capsule facade and preserves explicit operation identity without automatic replay', async () => {
  await import('../src/preload/capsule')
  const sdk = wire.api!
  expect(Object.keys(sdk).sort()).toEqual(['capabilities', 'createOperationId', 'inspectOperation', 'onThemeChanged', 'read', 'request', 'saveDraft', 'theme'])
  expect(sdk).not.toHaveProperty('reply'); expect(sdk).not.toHaveProperty('call')
  const operationId = sdk.createOperationId(); expect(isObjectId(operationId)).toBe(true)
  wire.invoke.mockResolvedValueOnce({ ok: false, error: { code: 'CAPSULE_OPERATION_UNKNOWN', message: 'Original operation outcome is unknown.' } })
  await expect(sdk.request('Choose a title', 'Draft title', operationId)).rejects.toMatchObject({ code: 'CAPSULE_OPERATION_UNKNOWN', operationId })
  const requests = wire.invoke.mock.calls.filter(([, action]) => action === 'request')
  expect(requests).toEqual([['capsule:document', 'request', { question: 'Choose a title', draft: 'Draft title', operationId }]])
  wire.invoke.mockResolvedValueOnce({ ok: true, value: { operationId, method: 'capsule.interaction.request', status: 'pending' } })
  await expect(sdk.inspectOperation(operationId)).resolves.toMatchObject({ operationId, status: 'pending' })
  expect(wire.invoke).toHaveBeenLastCalledWith('capsule:document', 'inspectOperation', { operationId })
  expect(wire.invoke.mock.calls.filter(([, action]) => action === 'request')).toHaveLength(1)
  const draftOperation = sdk.createOperationId()
  wire.invoke.mockResolvedValueOnce({ ok: true, value: { interactionId: 'interaction', draft: 'Retained draft' } })
  await sdk.saveDraft('interaction', 2, 'Retained draft', draftOperation)
  expect(wire.invoke).toHaveBeenLastCalledWith('capsule:document', 'saveDraft', {
    interactionId: 'interaction', expectedRevision: 2, draft: 'Retained draft', operationId: draftOperation
  })
  await sdk.read('interaction')
  expect(wire.invoke).toHaveBeenLastCalledWith('capsule:document', 'read', { interactionId: 'interaction' })
})

it('keeps child frames outside the SDK exposure boundary', async () => {
  Object.defineProperty(process, 'isMainFrame', { configurable: true, value: false })
  await import('../src/preload/capsule')
  expect(wire.api).toBeNull(); expect(wire.invoke).not.toHaveBeenCalled(); expect(wire.events.size).toBe(0)
})

it('projects the original theme tokens and delivers changes without letting one page listener suppress another', async () => {
  const light: CapsulePageTheme = { mode: 'light', tokens: { '--surface': '#fff', '--text': '#111', 'unsafe-property': 'ignored' } }
  wire.invoke.mockResolvedValue({ ok: true, value: light })
  document.documentElement.style.setProperty('--surface', 'page-original')
  await import('../src/preload/capsule'); await Promise.resolve()
  expect(document.documentElement.style.getPropertyValue('--surface')).toBe('#fff')
  expect(document.documentElement.style.getPropertyValue('unsafe-property')).toBe('')
  const notified = vi.fn(), broken = vi.fn(() => { throw new Error('Page callback failed') })
  wire.api!.onThemeChanged(broken)
  const unsubscribe = wire.api!.onThemeChanged(notified)
  const dark: CapsulePageTheme = { mode: 'dark', tokens: { '--surface': '#111', '--text': '#eee' } }
  wire.events.get('capsule:theme')!({}, dark)
  expect(document.documentElement.style.getPropertyValue('--surface')).toBe('#111')
  expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('dark')
  expect(notified).toHaveBeenCalledExactlyOnceWith(dark)
  unsubscribe(); wire.events.get('capsule:theme')!({}, null)
  expect(notified).toHaveBeenCalledTimes(1)
  expect(document.documentElement.style.getPropertyValue('--surface')).toBe('page-original')
  expect(document.documentElement.style.getPropertyValue('--text')).toBe('')
})

it('leaves the original page readable when optional theme acquisition fails', async () => {
  wire.invoke.mockResolvedValue({ ok: false, error: { code: 'CONTROL_UNAVAILABLE', message: 'App appearance unavailable' } })
  document.documentElement.style.setProperty('--surface', 'page-original')
  await import('../src/preload/capsule'); await Promise.resolve()
  expect(wire.api).not.toBeNull()
  expect(document.documentElement.style.getPropertyValue('--surface')).toBe('page-original')
})
