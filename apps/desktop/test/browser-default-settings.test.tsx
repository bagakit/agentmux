// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { createClientUiRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserDefaultInspection } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts'
import { surveySettingsModule } from '../src/renderer/src/components/settings/modules/survey'

const ui = vi.hoisted(() => ({ inspect: vi.fn(), open: vi.fn(), save: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { ui: { inspectDefaultBrowser: ui.inspect, openDefaultBrowserSettings: ui.open }, config: { save: ui.save } } }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: { getState: () => ({ config: null }) } }))
const current = (matched = false): BrowserDefaultInspection => ({ platform: 'darwin', outcome: matched ? 'default' : 'not-default', protocols: { http: { state: 'known', isCurrentApplication: matched, application: { name: matched ? 'AgentMux' : 'Another browser', path: 'application-bundle' } }, https: { state: 'known', isCurrentApplication: matched, application: { name: matched ? 'AgentMux' : 'Another browser', path: 'application-bundle' } } } })
const config = { browser: { startPage: { title: 'Original title', subtitle: 'Original subtitle', icon: '', backgroundImage: '', showHistory: true } } } as AppConfig
const Pane = surveySettingsModule.Pane
const view = (active = true) => <Pane config={config} active={active} onClose={() => {}} onNavigate={() => {}} />
beforeEach(() => { ui.inspect.mockReset().mockResolvedValue(current()); ui.open.mockReset().mockResolvedValue({ requested: true, target: 'default-web-browser', platform: 'darwin' }) })
let container: HTMLDivElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
async function render(element: ReturnType<typeof view>) { await act(async () => root.render(element)); return { rerender: render } }
async function waitFor(assertion: () => void) { for (let n = 0; n < 40; n++) { try { assertion(); return } catch { await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)) }) } } assertion() }
const screen = {
  getByRole(role: string, options?: { name: string }): HTMLElement { const target = [...container.querySelectorAll<HTMLElement>(role === 'button' ? 'button' : `[role="${role}"]`)].find(node => !options || node.textContent === options.name); expect(target, `actual ${role} ${options?.name}`).toBeTruthy(); return target! },
  getByLabelText(label: string): HTMLElement { const target = container.querySelector<HTMLElement>(`[aria-label="${label}"]`); expect(target).toBeTruthy(); return target! },
  queryByText(text: string | RegExp): HTMLElement | null { return [...container.querySelectorAll<HTMLElement>('p')].find(node => typeof text === 'string' ? node.textContent === text : text.test(node.textContent ?? '')) ?? null },
  async findByText(text: string | RegExp) { await waitFor(() => expect(screen.queryByText(text)).toBeTruthy()); return screen.queryByText(text)! }
}
const fireEvent = {
  async change(node: HTMLElement, input: { target: { value: string } }) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, input.target.value); node.dispatchEvent(new Event('input', { bubbles: true })) }) },
  async click(node: HTMLElement) { await act(async () => node.click()) },
  async focus() { await act(async () => { window.dispatchEvent(new Event('focus')) }) }
}

it('offers the explicit action in the original Survey module and does not turn a request into a default fact', async () => {
  await render(view()); await screen.findByText('Web links currently open in another app.')
  await fireEvent.change(screen.getByLabelText('Start page title'), { target: { value: 'Unsaved start page draft' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Set as default browser…' }))
  await screen.findByText(/System Settings requested/)
  expect(ui.open).toHaveBeenCalledTimes(1); expect(screen.queryByText('Web links currently open in another app.')).toBeTruthy()
  expect((screen.getByLabelText('Start page title') as HTMLInputElement).value).toBe('Unsaved start page draft')
  expect(ui.save).not.toHaveBeenCalled()
})
it('keeps system settings available after an unknown read and ignores a superseded status reply', async () => {
  let finish!: (fact: BrowserDefaultInspection) => void
  ui.inspect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValueOnce(current(true))
  await render(view()); await waitFor(() => expect(ui.inspect).toHaveBeenCalledTimes(1))
  await fireEvent.focus(); await screen.findByText('AgentMux is your default browser. Web links open in Survey.')
  await act(async () => { finish(current()); await Promise.resolve() })
  expect(screen.queryByText('Web links currently open in another app.')).toBeNull()
  ui.inspect.mockRejectedValueOnce(new Error('Original query unavailable'))
  await fireEvent.click(screen.getByRole('button', { name: 'Refresh status' })); await screen.findByText(/Original query unavailable/)
  expect(screen.queryByText('AgentMux is your default browser. Web links open in Survey.')).toBeNull()
  expect((screen.getByRole('button', { name: 'Set as default browser…' }) as HTMLButtonElement).disabled).toBe(false)
})
it('does not duplicate a busy request or retain its disabled state or late error after hiding and returning', async () => {
  let fail!: (error: Error) => void
  ui.open.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  const result = await render(view()); await screen.findByText('Web links currently open in another app.')
  const button = screen.getByRole('button', { name: 'Set as default browser…' })
  await fireEvent.click(button); await fireEvent.click(button); expect(ui.open).toHaveBeenCalledTimes(1)
  await result.rerender(view(false)); await act(async () => { fail(new Error('Old late request failure')); await Promise.resolve() })
  await result.rerender(view()); await waitFor(() => expect((screen.getByRole('button', { name: 'Set as default browser…' }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByText(/Old late request failure/)).toBeNull()
})
it('does not inspect or subscribe while its original Settings pane is hidden', async () => {
  const result = await render(view(false)); await fireEvent.focus(); await act(async () => { await Promise.resolve() }); expect(ui.inspect).not.toHaveBeenCalled()
  await result.rerender(view()); await screen.findByText('Web links currently open in another app.'); expect(ui.inspect).toHaveBeenCalledTimes(1)
  await result.rerender(view(false)); await fireEvent.focus(); expect(ui.inspect).toHaveBeenCalledTimes(1)
})
