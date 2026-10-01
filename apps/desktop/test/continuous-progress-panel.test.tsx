// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContinuousProgressPanel } from '../src/renderer/src/components/ContinuousProgressPanel'
import { ContinuousProgressControl } from '../src/renderer/src/components/ContinuousProgressControl'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import type { ContinuousProgressLoop } from '@agentmux/core'

const dom = composerDOM()
const target = { hostId: 'local', agentSessionId: 'agent-1', providerId: 'codex', workspacePath: '/repo' }
const savedPrompt = 'Keep the original input.\nRead every line of this saved continuation.\nEnd of the saved prompt.'
const saved = (status: ContinuousProgressLoop['status'] = 'active'): ContinuousProgressLoop => ({
  ...target, loopId: 'original-loop', intervalMs: 1_020_000, prompt: savedPrompt, status,
  nextCheckAt: 60_000, lastTickAt: 1_000, lastDecision: 'Original decision\nwith its full reason.',
  taskSource: { root: '/tracker/root', ownerId: 'f-current', readerPath: '/tracker/feature-tracker.sh' }
})
async function mount(loop: ContinuousProgressLoop) {
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([loop])
  vi.spyOn(api.continuousProgress, 'onChanged').mockImplementation(() => vi.fn())
  await dom.render(<ContinuousProgressControl session={composerSession()} />)
  await vi.waitFor(() => expect(dom.container.querySelector('[data-progress-state]')?.getAttribute('data-progress-state')).not.toBe('unconfirmed'))
}

describe('continuous progress panel', () => {
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
    expect([...config.querySelectorAll('dd')].map(el => el.textContent)).toEqual(['17 minutes', 'f-current', '/tracker/root', '/tracker/feature-tracker.sh'])
    const details = dom.container.querySelector<HTMLDetailsElement>('[data-progress-details="target"]')!
    await act(async () => { details.open = true })
    expect([...details.querySelectorAll('dd')].map(el => el.textContent)).toEqual(['Codex (codex)', 'local', 'agent-1', '/repo'])
    expect(dom.container.querySelector('.continuous-progress-panel__decision p')!.textContent).toBe('Original decision\nwith its full reason.')
    expect(dom.container.querySelector('form') !== null).toBe(status === 'stopped')
    expect(dom.container.querySelector('[aria-label="Check continuous progress now"]')?.hasAttribute('disabled') ?? true).toBe(status !== 'active')
    expect([...dom.container.querySelectorAll('.continuous-progress-panel__summary dt')].map(el => el.textContent)).toEqual(status === 'active'
      ? ['Loop', 'Agent execution', 'Next check', 'Last check'] : ['Loop', 'Agent execution', 'Last check'])
    expect(api.continuousProgress.list).toHaveBeenCalledExactlyOnceWith(target)
    expect(api.continuousProgress.onChanged).toHaveBeenCalledTimes(1)
  })

  it('puts unconfirmed ahead of the last known active loop and makes no next-check promise', async () => {
    const loop = { ...saved(), lastOutcome: 'unknown' as const }
    vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([loop])
    await dom.render(<ContinuousProgressControl session={composerSession()} />)
    await vi.waitFor(() => expect(dom.container.querySelector('[data-progress-details="configuration"]')).not.toBeNull())
    expect(dom.container.querySelector('.continuous-progress-control__heading')!.textContent).toBe('Continuous progressUnconfirmed')
    expect(dom.container.querySelector('[role="status"]')!.textContent).toContain('Manual input follows terminal readiness.')
    expect([...dom.container.querySelectorAll('.continuous-progress-panel__summary dt')].map(el => el.textContent)).toEqual(['Last known loop status', 'Agent execution', 'Last check'])
    expect(dom.container.querySelector('.continuous-progress-panel__summary')!.textContent).toContain('active')
  })

  it('keeps native details toggles within Progress rather than reopening the shared mailbox', async () => {
    const ownerToggle = vi.fn()
    vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([saved()])
    const observe = vi.spyOn(api.continuousProgress, 'onChanged').mockImplementation(() => vi.fn())
    await dom.render(<div onToggle={ownerToggle}><ContinuousProgressControl session={composerSession()} /></div>)
    await vi.waitFor(() => expect(dom.container.querySelector('[data-progress-details="configuration"]')).not.toBeNull())
    const details = [...dom.container.querySelectorAll<HTMLDetailsElement>('[data-progress-details]')]
    expect(details).toHaveLength(2)
    await act(async () => {
      for (const detail of details) {
        detail.open = true
        const toggle = new Event('toggle'); Object.defineProperty(toggle, 'newState', { value: 'open' })
        detail.dispatchEvent(toggle)
      }
    })
    expect(ownerToggle).not.toHaveBeenCalled()
    expect(api.continuousProgress.list).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledTimes(1)
  })

  it('calls the original target, loop and action once and retains the busy/error boundary', async () => {
    await mount(saved())
    let finish!: (loop: ContinuousProgressLoop) => void
    const action = vi.spyOn(api.continuousProgress, 'action').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pause = dom.container.querySelector<HTMLButtonElement>('[aria-label="Pause continuous progress"]')!
    await act(async () => pause.click())
    expect(action).toHaveBeenCalledExactlyOnceWith(target, 'original-loop', 'pause')
    expect([...dom.container.querySelectorAll<HTMLButtonElement>('.continuous-progress-panel__actions button')].map(el => el.disabled)).toEqual([true, true, true])
    await act(async () => pause.click())
    expect(action).toHaveBeenCalledTimes(1)
    await act(async () => finish(saved('paused')))
    action.mockResolvedValueOnce(saved())
    await dom.click('[aria-label="Resume continuous progress"]')
    expect(action).toHaveBeenLastCalledWith(target, 'original-loop', 'resume')
    action.mockRejectedValueOnce(new Error('Original action failure reason'))
    await dom.click('[aria-label="Check continuous progress now"]')
    expect(action).toHaveBeenLastCalledWith(target, 'original-loop', 'check')
    expect(dom.container.querySelector('[role="status"]')!.textContent).toContain('Original action failure reason')
    expect(dom.container.querySelector('.continuous-progress-panel__summary')!.textContent).toContain('Last known loop status')
    action.mockResolvedValueOnce(saved('stopped'))
    await dom.click('[aria-label="Stop continuous progress"]')
    expect(action.mock.calls).toEqual([[target, 'original-loop', 'pause'], [target, 'original-loop', 'resume'], [target, 'original-loop', 'check'], [target, 'original-loop', 'stop']])
    expect(dom.container.querySelector('form')).not.toBeNull()
  })
})
