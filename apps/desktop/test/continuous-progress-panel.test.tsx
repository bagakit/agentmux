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

async function openNewAutomation() {
  await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'New automation')!.click())
  expect(dom.container.querySelector<HTMLElement>('[data-automation-view="overview"]')!.hidden).toBe(true)
  expect(dom.container.querySelector<HTMLElement>('[data-automation-view="editor"]')!.hidden).toBe(false)
}
async function showProgressEditor() {
  const form = dom.container.querySelector<HTMLFormElement>('form[aria-label="Continuous progress setup"]')!
  if (!form.closest('[hidden]')) return
  const edit = dom.container.querySelector<HTMLButtonElement>('[aria-label="Edit continuous progress"]')
  if (edit) await dom.click('[aria-label="Edit continuous progress"]')
  else {
    await openNewAutomation()
    await dom.click('[aria-label="Automation type"] input[value="progress"]')
  }
  expect(form.closest('[hidden]')).toBeNull()
}

describe('continuous progress panel', () => {
  it('keeps the same composing continuation field when a late read finds an existing loop', async () => {
    let resolve!: (loops: ContinuousProgressLoop[]) => void
    vi.spyOn(api.continuousProgress, 'list').mockReturnValue(new Promise(done => { resolve = done }))
    await dom.render(<ContinuousProgressControl session={composerSession()} targetName="Original task agent" />)
    expect(dom.container.querySelector('.automation-target')!.textContent).toContain('Original task agent')
    expect(dom.container.querySelector('[data-progress-details="target"]')!.textContent).toContain(target.agentSessionId)
    await openNewAutomation()
    await dom.click('[aria-label="Automation type"] input[value="progress"]')
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
    await act(async () => field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '确认后的续行提示' })))
    expect(dom.container.querySelector<HTMLButtonElement>('form[aria-label="Continuous progress setup"] button[type="submit"]')!.disabled).toBe(false)
  })

  async function edit(selector: string, value: string) {
    await showProgressEditor()
    const element = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] ' + selector)!
    await act(async () => {
      const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const submit = async () => { await showProgressEditor(); await dom.click('form[aria-label="Continuous progress setup"] button[type="submit"]') }

  it.each(['active', 'paused'] as const)('edits and saves the original %s loop without a second creation or state action', async status => {
    const original = saved(status), updated = { ...original, intervalMs: 3_600_000, prompt: '检查最新成果', revision: 1 }
    const update = vi.spyOn(api.continuousProgress, 'update').mockResolvedValue(updated)
    const create = vi.spyOn(api.continuousProgress, 'create'), action = vi.spyOn(api.continuousProgress, 'action')
    await mount(original)
    await showProgressEditor()
    expect(dom.container.querySelector<HTMLElement>('[data-automation-view="overview"]')!.hidden).toBe(true)
    expect(dom.container.querySelector<HTMLElement>('[data-automation-view="editor"]')!.hidden).toBe(false)
    const chooser = dom.container.querySelector<HTMLElement>('[aria-label="Automation type"]')
    expect(chooser === null || chooser.closest('[hidden]') !== null).toBe(true)
    expect(dom.container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!.value).toBe(savedPrompt)
    expect(dom.container.querySelector<HTMLInputElement>('form[aria-label="Continuous progress setup"] input[type="number"]')!.value).toBe('17')
    await edit('input[type="number"]', '60'); await edit('textarea', '检查最新成果')
    await submit()
    expect(update).toHaveBeenCalledExactlyOnceWith({ target, loopId: original.loopId, expectedLoop: original, intervalMs: 3_600_000, prompt: '检查最新成果', operationId: expect.any(String) })
    expect(create).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled()
    expect(dom.container.textContent).toContain('Changes saved.')
    if (status === 'paused') expect(dom.container.textContent).toContain('remains paused')
    expect(useLauncherState.getState().drafts['progress-update:' + JSON.stringify(Object.values(target))]?.progressUpdate).toBeUndefined()
  })

  it('shows a later observation failure in the current editor without hiding the confirmed save receipt', async () => {
    const original = saved('paused')
    await mount(original)
    const updated = { ...original, prompt: 'Confirmed update', revision: 1 }
    vi.spyOn(api.continuousProgress, 'update').mockResolvedValue(updated)
    await edit('textarea', updated.prompt); await submit()
    const editor = dom.container.querySelector<HTMLElement>('[data-automation-view="editor"]')!
    expect(editor.hidden).toBe(false)
    expect([...editor.querySelectorAll('[role="status"]')].filter(node => !node.closest('[hidden]')).map(node => node.textContent).join(' ')).toContain('Changes saved.')
    vi.mocked(api.continuousProgress.list).mockRejectedValueOnce(new Error('Current observation unavailable'))
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await vi.waitFor(() => {
      const notices = [...editor.querySelectorAll('[role="status"]')].filter(node => !node.closest('[hidden]'))
      expect(notices.length).toBeGreaterThan(0)
      expect(notices.map(node => node.textContent).join(' ')).toContain('Current observation unavailable')
      expect(notices.map(node => node.textContent).join(' ')).toContain('Changes saved.')
    })
    expect(editor.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!.value).toBe(updated.prompt)
    expect(dom.draft()).toBe('Keep my draft')
  })

  it('keeps the exact failed save through observations and retries without sending a newer draft', async () => {
    await mount(saved())
    const update = vi.spyOn(api.continuousProgress, 'update').mockRejectedValueOnce(new Error('Save reply lost'))
    await edit('textarea', 'Original requested update'); await submit()
    const request = structuredClone(update.mock.calls[0]![0])
    await edit('textarea', 'A newer unsaved draft')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(update).toHaveBeenCalledTimes(1)
    expect(dom.container.textContent).toContain('Previous save is unconfirmed')
    expect(dom.container.textContent).toContain('Save reply lost')
    update.mockResolvedValueOnce({ ...saved(), prompt: request.prompt, revision: 1 })
    await submit()
    expect(update).toHaveBeenLastCalledWith(request)
    expect(dom.container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!.value).toBe('A newer unsaved draft')
    expect(dom.container.querySelector<HTMLButtonElement>('form[aria-label="Continuous progress setup"] button[type="submit"]')!.textContent).toBe('Save changes')
  })

  it('keeps a draft after a configuration conflict and only adopts a fresh baseline on explicit review', async () => {
    await mount(saved())
    const update = vi.spyOn(api.continuousProgress, 'update').mockRejectedValueOnce(Object.assign(new Error('Original configuration changed'), { code: 'CONTROL_REQUEST_CONFLICT' }))
    await edit('textarea', 'My retained update'); await submit()
    const latest = { ...saved(), prompt: 'Someone else changed it', revision: 2 }
    vi.mocked(api.continuousProgress.list).mockResolvedValue([latest])
    const review = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Review latest settings')!
    await act(async () => review.click())
    expect(dom.container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!.value).toBe('My retained update')
    expect(dom.container.querySelector('.continuous-progress-control__prompt')!.textContent).toBe(latest.prompt)
    update.mockResolvedValueOnce({ ...latest, prompt: 'My retained update', revision: 3 })
    await submit()
    expect(update.mock.calls[1]![0].expectedLoop).toEqual(latest)
    expect(update.mock.calls[1]![0].operationId).not.toBe(update.mock.calls[0]![0].operationId)
  })

  it('retains an unknown original request when a newer configuration supersedes its receipt and lets the user explicitly save again', async () => {
    await mount(saved())
    const update = vi.spyOn(api.continuousProgress, 'update').mockRejectedValueOnce(new Error('Lost original reply'))
    await edit('textarea', 'Original unknown change'); await submit()
    const original = structuredClone(update.mock.calls[0]![0])
    update.mockRejectedValueOnce(Object.assign(new Error('The original update was superseded'), { code: 'CONTROL_REQUEST_CONFLICT' }))
    await submit()
    await edit('textarea', 'My next explicit change')
    const latest = { ...saved(), prompt: 'Another client updated', revision: 4 }
    vi.mocked(api.continuousProgress.list).mockResolvedValue([latest])
    await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Review latest settings')!.click())
    expect(dom.container.textContent).toContain(original.operationId)
    expect(dom.container.textContent).toContain('The previous save remains unconfirmed below.')
    expect(dom.container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!.value).toBe('My next explicit change')
    update.mockResolvedValueOnce({ ...latest, prompt: 'My next explicit change', revision: 5 })
    await submit()
    expect(update.mock.calls[2]![0].expectedLoop).toEqual(latest)
    expect(update.mock.calls[2]![0].operationId).not.toBe(original.operationId)
    expect(Object.values(useLauncherState.getState().drafts).flatMap(draft => draft.unconfirmedProgressUpdates ?? [])).toEqual([original])
  })

  it('keeps a newer draft separately from its pending request across a different target and remount', async () => {
    await mount(saved())
    const update = vi.spyOn(api.continuousProgress, 'update').mockRejectedValueOnce(new Error('Save reply lost'))
    await edit('textarea', 'Original request'); await submit()
    const request = structuredClone(update.mock.calls[0]![0])
    await edit('textarea', 'New unsaved draft'); await edit('input[type="number"]', '60')
    await dom.render(<div />)
    vi.mocked(api.continuousProgress.list).mockResolvedValue([])
    const other = composerSession(); other.control = { ...other.control, agentSessionId: 'another-agent' }
    await dom.render(<ContinuousProgressControl session={other} />)
    expect(dom.container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!.value).not.toBe('New unsaved draft')
    await mount(saved())
    expect(dom.container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!.value).toBe('New unsaved draft')
    expect(dom.container.querySelector<HTMLInputElement>('form[aria-label="Continuous progress setup"] input[type="number"]')!.value).toBe('60')
    update.mockResolvedValueOnce({ ...saved(), prompt: request.prompt, revision: 1 })
    await submit()
    expect(update).toHaveBeenLastCalledWith(request)
    expect(dom.container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!.value).toBe('New unsaved draft')
  })

  it('keeps the draft and an explicit retry when the original save request cannot be retained locally', async () => {
    await mount(saved())
    await edit('textarea', 'Retained in the editor')
    const update = vi.spyOn(api.continuousProgress, 'update')
    const remember = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage is unavailable') })
    await submit()
    expect(remember).toHaveBeenCalled(); expect(update).not.toHaveBeenCalled()
    expect(dom.container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!.value).toBe('Retained in the editor')
    expect(dom.container.textContent).toContain('save request could not be retained')
    expect(dom.container.textContent).not.toContain('Previous save is unconfirmed')
    expect(Object.values(useLauncherState.getState().drafts).some(draft => !!draft.progressUpdate)).toBe(false)
    expect(dom.container.querySelector<HTMLButtonElement>('form[aria-label="Continuous progress setup"] button[type="submit"]')!.disabled).toBe(false)
    remember.mockRestore()
    await edit('textarea', 'The next explicit value')
    update.mockResolvedValueOnce({ ...saved(), prompt: 'The next explicit value', revision: 1 })
    await submit()
    expect(update.mock.calls[0]![0].prompt).toBe('The next explicit value')
  })

  it('retains untouched saved values when reviewing an unknown save and reopening the editor', async () => {
    await mount(saved())
    vi.spyOn(api.continuousProgress, 'update').mockRejectedValueOnce(new Error('Reply lost'))
    await submit()
    await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Review latest settings')!.click())
    await dom.render(<div />); await mount(saved())
    expect(dom.container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!.value).toBe(savedPrompt)
    expect(dom.container.querySelector<HTMLInputElement>('form[aria-label="Continuous progress setup"] input[type="number"]')!.value).toBe('17')
  })

  it('creates a minute schedule for this Agent and keeps its draft while changing the automation type', async () => {
    vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
    const create = vi.spyOn(api.schedule, 'create').mockRejectedValue(new Error('Original receipt unconfirmed'))
    await dom.render(<ContinuousProgressControl session={composerSession()} />)
    await openNewAutomation()
    const interval = dom.container.querySelector<HTMLInputElement>('[aria-label="Repeat interval in minutes"]')!
    const message = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Arranged message"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(interval, '1')
      interval.dispatchEvent(new Event('input', { bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(message, 'Check for the original result')
      message.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await dom.click('[aria-label="Automation type"] input[value="progress"]')
    expect(message.closest('[hidden]')).not.toBeNull()
    await dom.click('[aria-label="Automation type"] input[value="schedule"]')
    expect(message.closest('[hidden]')).toBeNull()
    expect(dom.container.querySelector('[aria-label="Arranged message"]')).toBe(message)
    expect(message.value).toBe('Check for the original result')
    const form = message.closest('form')!
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]![0]).toMatchObject({ target, everyMs: 60000, prompt: 'Check for the original result', operationId: expect.any(String) })
    expect(message.value).toBe('Check for the original result')
  })

  it('returns from an isolated editor to its original entry without replacing the unsaved prompt', async () => {
    await mount(saved('paused'))
    const overview = dom.container.querySelector<HTMLElement>('[data-automation-view="overview"]')!
    const editor = dom.container.querySelector<HTMLElement>('[data-automation-view="editor"]')!
    const open = dom.container.querySelector<HTMLButtonElement>('[aria-label="Edit continuous progress"]')!
    const field = editor.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!
    expect(overview.hidden).toBe(false); expect(editor.hidden).toBe(true)
    await showProgressEditor()
    expect(overview.hidden).toBe(true); expect(editor.hidden).toBe(false)
    await edit('textarea', 'Keep this original draft after returning')
    await dom.render(<ContinuousProgressControl session={composerSession()} visible={false} />)
    expect(open.isConnected).toBe(false)
    await dom.render(<ContinuousProgressControl session={composerSession()} />)
    const currentEntry = dom.container.querySelector<HTMLButtonElement>('[aria-label="Edit continuous progress"]')!
    expect(currentEntry).not.toBe(open)
    await dom.click('[aria-label="Back to automations"]')
    expect(overview.hidden).toBe(false); expect(editor.hidden).toBe(true)
    await vi.waitFor(() => expect(document.activeElement).toBe(currentEntry))
    await showProgressEditor()
    expect(editor.querySelector('form[aria-label="Continuous progress setup"] textarea')).toBe(field)
    expect(field.value).toBe('Keep this original draft after returning')
    expect(dom.draft()).toBe('Keep my draft')
    expect(api.continuousProgress.list).toHaveBeenCalledTimes(2)
  })

  it('keeps an invalid fractional interval editable without creating an unknown operation', async () => {
    vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
    const create = vi.spyOn(api.schedule, 'create')
    await dom.render(<ContinuousProgressControl session={composerSession()} />)
    await openNewAutomation()
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
    expect(config.querySelector('summary')!.textContent).toBe('Saved configuration')
    await act(async () => { config.open = true })
    expect(config.textContent).toContain('17 minutes')
    expect(config.querySelector('.continuous-progress-control__prompt')!.textContent).toBe(savedPrompt)
    expect([...config.querySelectorAll('dd')].map(el => el.textContent)).toEqual(['17 minutes', 'f-current', _hygiene_fixturePath("tracker/root"), _hygiene_fixturePath("tracker/feature-tracker.sh")])
    const details = dom.container.querySelector<HTMLDetailsElement>('[data-progress-details="target"]')!
    await act(async () => { details.open = true })
    expect([...details.querySelectorAll('dd')].map(el => el.textContent)).toEqual(['codex', 'Codex (codex)', 'local', 'agent-1', _hygiene_fixturePath("repo")])
    expect(dom.container.querySelector('.continuous-progress-panel__decision p')!.textContent).toBe('Original decision\nwith its full reason.')
    expect(dom.container.querySelector('[aria-label="Continuation settings"]')).not.toBeNull()
    if (status !== 'stopped') {
      expect(dom.container.querySelector<HTMLButtonElement>('form[aria-label="Continuous progress setup"] button[type="submit"]')!.disabled).toBe(false)
      expect(dom.container.querySelector<HTMLButtonElement>('form[aria-label="Continuous progress setup"] button[type="submit"]')!.textContent).toBe('Save changes')
    }
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
    const details = [...dom.container.querySelectorAll<HTMLDetailsElement>('[data-progress-details], [aria-label="Optional task source"]')]
    expect(details).toHaveLength(4)
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
    expect(dom.container.querySelector('[aria-label="Check continuous progress now"]')).toBeNull()
    expect(dom.container.querySelector('[aria-label="Resume and check continuous progress"]')!.textContent).toBe('Resume and check')
    action.mockResolvedValueOnce(saved())
    await dom.click('[aria-label="Resume and check continuous progress"]')
    expect(action).toHaveBeenLastCalledWith(target, 'original-loop', 'resume', saved('paused'), expect.any(String))
    action.mockRejectedValueOnce(new Error('Original action failure reason'))
    await dom.click('[aria-label="Check continuous progress now"]')
    expect(action).toHaveBeenLastCalledWith(target, 'original-loop', 'check', saved(), expect.any(String))
    expect(dom.container.querySelector('.continuous-progress-panel [role="status"]')!.textContent).toContain('Original action failure reason')
    expect(dom.container.querySelector('.continuous-progress-panel__summary')!.textContent).toContain('Last known loop status')
    const reads = vi.mocked(api.continuousProgress.list).mock.calls.length
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(api.continuousProgress.list).toHaveBeenCalledTimes(reads + 1)
    expect(dom.container.querySelector('.continuous-progress-panel [role="status"]')).not.toBeNull()
    expect(dom.container.querySelector('.continuous-progress-panel [role="status"]')!.textContent).toContain('Original action failure reason')
    action.mockResolvedValueOnce(saved('stopped'))
    await dom.click('[aria-label="Stop continuous progress"]')
    expect(action.mock.calls.map(call => call.slice(0, 3))).toEqual([[target, 'original-loop', 'pause'], [target, 'original-loop', 'resume'], [target, 'original-loop', 'check'], [target, 'original-loop', 'stop']])
    expect(dom.container.querySelector('form')).not.toBeNull()
  })

  it('shows a pending check and its skipped outcome without treating completion as delivery', async () => {
    await mount(saved())
    let finish!: (loop: ContinuousProgressLoop) => void
    vi.spyOn(api.continuousProgress, 'action').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await dom.click('[aria-label="Check continuous progress now"]')
    expect(dom.container.querySelector('.continuous-progress-panel')!.getAttribute('aria-busy')).toBe('true')
    expect(dom.container.querySelector('.continuous-progress-panel [role="status"]')!.textContent).toBe('Checking this Agent…')
    await act(async () => finish({ ...saved(), lastOutcome: 'skipped', lastDecision: 'working' }))
    expect(dom.container.querySelector('.continuous-progress-panel')!.getAttribute('aria-busy')).toBe('false')
    expect(dom.container.querySelector('.continuous-progress-panel [role="status"]')!.textContent).toBe('Check complete. No continuation prompt was sent.')
    expect(dom.container.querySelector('.continuous-progress-panel__decision')!.textContent).toContain('The Agent is still working.')
    expect(dom.container.querySelector('.continuous-progress-panel')!.textContent).not.toContain('Host accepted')
  })
})
