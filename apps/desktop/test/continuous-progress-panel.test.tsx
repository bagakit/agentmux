import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContinuousProgressPanel } from '../src/renderer/src/components/ContinuousProgressPanel'
import { ContinuousProgressControl } from '../src/renderer/src/components/ContinuousProgressControl'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import type { ContinuousProgressLoop } from '@agentmux/core'

const dom = composerDOM()
beforeEach(() => {
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
})
const target = { hostId: 'local', agentSessionId: 'agent-1', providerId: 'codex', workspacePath: _hygiene_fixturePath("repo") }
const savedPrompt = 'Keep the original input.\nRead every line of this saved continuation.\nEnd of the saved prompt.'
const saved = (status: ContinuousProgressLoop['status'] = 'active'): ContinuousProgressLoop => ({
  ...target, loopId: 'original-loop', intervalMs: 1_020_000, prompt: savedPrompt, status,
  nextCheckAt: 60_000, lastTickAt: 1_000, lastDecision: 'Original decision\nwith its full reason.',
  taskSource: { root: _hygiene_fixturePath("tracker/root"), ownerId: 'f-current', readerPath: _hygiene_fixturePath("tracker/feature-tracker.sh") }
})
async function mount(loop: ContinuousProgressLoop) {
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([loop])
  await dom.render(<ContinuousProgressControl session={composerSession()} />)
  await vi.waitFor(() => expect(dom.container.querySelector('[data-progress-state]')?.getAttribute('data-progress-state')).not.toBe('unconfirmed'))
}

describe('continuous progress panel', () => {
  it('keeps the same composing continuation field when a late read finds an existing loop', async () => {
    let resolve!: (loops: ContinuousProgressLoop[]) => void
    vi.spyOn(api.continuousProgress, 'list').mockReturnValue(new Promise(done => { resolve = done }))
    await dom.render(<ContinuousProgressControl session={composerSession()} targetName="Original task agent" />)
    expect(dom.container.querySelector('.automation-target')!.textContent).toContain('Original task agent')
    expect(dom.container.querySelector('.automation-target')!.textContent).toContain(target.agentSessionId)
    const panel = dom.container.querySelector<HTMLDetailsElement>('.automation-create')!
    await act(async () => {
      panel.open = true; panel.dispatchEvent(new Event('toggle'))
      const kind = dom.container.querySelector<HTMLSelectElement>('[aria-label="Automation type"]')!
      kind.value = 'progress'; kind.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const field = dom.container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!
    await act(async () => {
      field.focus()
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '候选输入')
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '候选输入' }))
      field.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '候选输入' }))
    })
    await act(async () => resolve([saved()]))
    expect(dom.container.querySelector('form[aria-label="Continuous progress setup"] textarea')).toBe(field)
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe('候选输入')
    expect(dom.container.querySelector<HTMLButtonElement>('form[aria-label="Continuous progress setup"] button[type="submit"]')!.disabled).toBe(true)
  })

  it('creates a minute schedule for this Agent and keeps its draft while changing the automation type', async () => {
    vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
    const create = vi.spyOn(api.schedule, 'create').mockRejectedValue(new Error('Original receipt unconfirmed'))
    await dom.render(<ContinuousProgressControl session={composerSession()} />)
    const createPanel = dom.container.querySelector<HTMLDetailsElement>('.automation-create')!
    await act(async () => { createPanel.open = true; createPanel.dispatchEvent(new Event('toggle')) })
    const interval = dom.container.querySelector<HTMLInputElement>('[aria-label="Repeat interval in minutes"]')!
    const message = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Arranged message"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(interval, '1')
      interval.dispatchEvent(new Event('input', { bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(message, 'Check for the original result')
      message.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const kind = dom.container.querySelector<HTMLSelectElement>('[aria-label="Automation type"]')!
    await act(async () => { kind.value = 'progress'; kind.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(dom.container.textContent).toContain('Busy checks are skipped')
    await act(async () => { kind.value = 'schedule'; kind.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(dom.container.querySelector('[aria-label="Arranged message"]')).toBe(message)
    expect(message.value).toBe('Check for the original result')
    const form = message.closest('form')!
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]![0]).toMatchObject({ target, everyMs: 60000, prompt: 'Check for the original result', operationId: expect.any(String) })
    expect(message.value).toBe('Check for the original result')
  })

  it('keeps an invalid fractional interval editable without creating an unknown operation', async () => {
    vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
    const create = vi.spyOn(api.schedule, 'create')
    await dom.render(<ContinuousProgressControl session={composerSession()} />)
    const interval = dom.container.querySelector<HTMLInputElement>('[aria-label="Repeat interval in minutes"]')!
    const message = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Arranged message"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(interval, '1.5')
      interval.dispatchEvent(new Event('input', { bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(message, 'Keep this message')
      message.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => message.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(create).not.toHaveBeenCalled()
    expect(message.value).toBe('Keep this message')
    expect(interval.disabled).toBe(false)
    expect(dom.container.textContent).toContain('whole number of minutes')
  })

  it('shows provider, split status, next check and actions', () => {
    const html = renderToStaticMarkup(<ContinuousProgressPanel loop={{ loopId: 'l', providerLabel: 'Codex', executionState: 'working', loopState: 'active', nextCheckAt: Date.now(), lastDecision: 'Skipped while busy' }} />)
    expect(html).toContain('Continuous progress · Codex')
    expect(html).toContain('<dt>Loop</dt><dd>active</dd>')
    expect(html).toContain('<dt>Agent execution</dt><dd>working</dd>')
    expect(html).toContain('Pause continuous progress')
    expect(html).toContain('Check now')
    expect(html).toContain('Stop loop')
    expect(html).toContain('Skipped while busy')
  })

  it.each(['active', 'paused', 'stopped'] as const)('keeps the exact saved configuration and target readable for %s', async status => {
    await mount(saved(status))
    const config = dom.container.querySelector<HTMLDetailsElement>('[data-progress-details="configuration"]')!
    expect(config).not.toBeNull()
    expect(config.querySelector('summary')!.textContent).toBe('Saved configuration Read only')
    await act(async () => { config.open = true })
    expect(config.textContent).toContain('17 minutes')
    expect(config.querySelector('.continuous-progress-control__prompt')!.textContent).toBe(savedPrompt)
    expect([...config.querySelectorAll('dd')].map(el => el.textContent)).toEqual(['17 minutes', 'f-current', _hygiene_fixturePath("tracker/root"), _hygiene_fixturePath("tracker/feature-tracker.sh")])
    const details = dom.container.querySelector<HTMLDetailsElement>('[data-progress-details="target"]')!
    await act(async () => { details.open = true })
    expect([...details.querySelectorAll('dd')].map(el => el.textContent)).toEqual(['Codex (codex)', 'local', 'agent-1', _hygiene_fixturePath("repo")])
    expect(dom.container.querySelector('.continuous-progress-panel__decision p')!.textContent).toBe('Original decision\nwith its full reason.')
    expect(dom.container.querySelector('[aria-label="Continuation settings"]')).not.toBeNull()
    if (status !== 'stopped') expect(dom.container.querySelector<HTMLButtonElement>('form[aria-label="Continuous progress setup"] button[type="submit"]')!.disabled).toBe(true)
    expect(dom.container.querySelector('[aria-label="Check continuous progress now"]')?.hasAttribute('disabled') ?? true).toBe(status !== 'active')
    expect([...dom.container.querySelectorAll('.continuous-progress-panel__summary dt')].map(el => el.textContent)).toEqual(status === 'active'
      ? ['Loop', 'Agent execution', 'Next check', 'Last check'] : ['Loop', 'Agent execution', 'Last check'])
    expect(api.continuousProgress.list).toHaveBeenCalledExactlyOnceWith(target)
  })

  it('puts unconfirmed ahead of the last known active loop and makes no next-check promise', async () => {
    const loop = { ...saved(), lastOutcome: 'unknown' as const }
    vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([loop])
    await dom.render(<ContinuousProgressControl session={composerSession()} />)
    await vi.waitFor(() => expect(dom.container.querySelector('[data-progress-details="configuration"]')).not.toBeNull())
    expect(dom.container.querySelector('[data-progress-details="interval"] > summary')!.textContent).toContain('Continuous progress Unconfirmed')
    expect(dom.container.querySelector('[role="status"]')!.textContent).toContain('Manual input follows terminal readiness.')
    expect([...dom.container.querySelectorAll('.continuous-progress-panel__summary dt')].map(el => el.textContent)).toEqual(['Last known loop status', 'Agent execution', 'Last check'])
    expect(dom.container.querySelector('.continuous-progress-panel__summary')!.textContent).toContain('active')
  })

  it('keeps native details toggles within Progress rather than reopening the shared mailbox', async () => {
    const ownerToggle = vi.fn()
    vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([saved()])
    await dom.render(<div onToggle={ownerToggle}><ContinuousProgressControl session={composerSession()} /></div>)
    await vi.waitFor(() => expect(dom.container.querySelector('[data-progress-details="configuration"]')).not.toBeNull())
    const details = [...dom.container.querySelectorAll<HTMLDetailsElement>('[data-progress-details]')]
    expect(details).toHaveLength(3)
    await act(async () => {
      for (const detail of details) {
        detail.open = true
        const toggle = new Event('toggle'); Object.defineProperty(toggle, 'newState', { value: 'open' })
        detail.dispatchEvent(toggle)
      }
    })
    expect(ownerToggle).not.toHaveBeenCalled()
    expect(api.continuousProgress.list).toHaveBeenCalledTimes(1)
  })

  it('calls the original target, loop and action once and retains the busy/error boundary', async () => {
    await mount(saved())
    let finish!: (loop: ContinuousProgressLoop) => void
    const action = vi.spyOn(api.continuousProgress, 'action').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pause = dom.container.querySelector<HTMLButtonElement>('[aria-label="Pause continuous progress"]')!
    await act(async () => pause.click())
    expect(action).toHaveBeenCalledExactlyOnceWith(target, 'original-loop', 'pause', saved(), expect.any(String))
    expect([...dom.container.querySelectorAll<HTMLButtonElement>('.continuous-progress-panel__actions button')].map(el => el.disabled)).toEqual([true, true, true])
    await act(async () => pause.click())
    expect(action).toHaveBeenCalledTimes(1)
    await act(async () => finish(saved('paused')))
    action.mockResolvedValueOnce(saved())
    await dom.click('[aria-label="Resume continuous progress"]')
    expect(action).toHaveBeenLastCalledWith(target, 'original-loop', 'resume', saved('paused'), expect.any(String))
    action.mockRejectedValueOnce(new Error('Original action failure reason'))
    await dom.click('[aria-label="Check continuous progress now"]')
    expect(action).toHaveBeenLastCalledWith(target, 'original-loop', 'check', saved(), expect.any(String))
    expect(dom.container.querySelector('[role="status"]')!.textContent).toContain('Original action failure reason')
    expect(dom.container.querySelector('.continuous-progress-panel__summary')!.textContent).toContain('Last known loop status')
    action.mockResolvedValueOnce(saved('stopped'))
    await dom.click('[aria-label="Stop continuous progress"]')
    expect(action.mock.calls.map(call => call.slice(0, 3))).toEqual([[target, 'original-loop', 'pause'], [target, 'original-loop', 'resume'], [target, 'original-loop', 'check'], [target, 'original-loop', 'stop']])
    expect(dom.container.querySelector('form')).not.toBeNull()
  })
})
