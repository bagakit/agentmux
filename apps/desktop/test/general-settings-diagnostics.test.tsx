// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { GeneralSettingsPane } from '../src/renderer/src/components/settings/GeneralSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => vi.restoreAllMocks())
const button = () => dom.container.querySelector<HTMLButtonElement>('button')!

it('renders requested, absent and original check failure without claiming health or visible Finder', async () => {
  const reveal = vi.spyOn(api.ui, 'revealCrashLog')
  await dom.render(<GeneralSettingsPane />)
  expect(dom.container.textContent).toContain('never uploaded')
  expect(dom.container.textContent).toContain('Remote AgentMux Runs are not supported yet')
  expect(dom.container.querySelector('[role="status"]')).toBeNull()
  reveal.mockResolvedValueOnce({ path: '/private/owned/log', outcome: 'requested' })
  await act(async () => button().click())
  expect(dom.container.querySelector('[role="status"]')?.textContent).toBe('Requested in your file manager./private/owned/log')
  reveal.mockResolvedValueOnce({ path: '/private/owned/absent', outcome: 'absent' })
  await act(async () => button().click())
  expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('No crash log file exists at this path.')
  expect(dom.container.textContent).not.toContain('No crashes recorded')
  reveal.mockResolvedValueOnce({ path: '/private/owned/restricted', outcome: 'check-failed', cause: { code: 'EACCES', message: 'Original inaccessible evidence' } })
  await act(async () => button().click())
  expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('EACCES · Original inaccessible evidence')
  expect(dom.container.querySelector('code')?.textContent).toBe('/private/owned/restricted')
  expect(dom.container.textContent).toContain('never uploaded')
  expect(dom.container.textContent).not.toContain('Opened')
  expect(reveal).toHaveBeenCalledTimes(3)
})

it('keeps the explicit action pending and gives an original IPC failure without inventing a path', async () => {
  let reject!: (error: Error) => void
  vi.spyOn(api.ui, 'revealCrashLog').mockReturnValue(new Promise((_, fail) => { reject = fail }))
  await dom.render(<GeneralSettingsPane />)
  await act(async () => button().click())
  expect(button().disabled).toBe(true)
  expect(button().textContent).toBe('Requesting…')
  await act(async () => reject(Object.assign(new Error('Original IPC unavailable'), { code: 'CONTROL_UNAVAILABLE' })))
  expect(button().disabled).toBe(false)
  expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('CONTROL_UNAVAILABLE · Original IPC unavailable')
  expect(dom.container.querySelector('code')).toBeNull()
})
