// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { settingsCliCommand as parseSettingsCommand } from '../../../packages/core/test/helpers/settings-command'
import { ConfigStore } from '../src/main/config-store'
import { executeSettingsControl } from '../src/main/settings-control'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import { configOwnerFixture } from './helpers/config-owner-fixture'

vi.mock('electron', () => ({ app: { getPath: () => 'unused-native-path' } }))
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea /> }))

const dom = composerDOM()
const reviewer = { hostId: 'local', runtimeId: 'review-runtime', sessionId: 'review-session' }
const field = <Element extends HTMLElement>(label: string) => dom.container.querySelector<Element>(`[aria-label="${label}"]`)!
const clickSettings = (target: string) => dom.click(`.settings-sidebar [data-settings-target="${target}"]`)
const saveSelector = '[data-settings-field="goal-workflows"] [data-settings-save-bar] button'
async function fill(label: string, value: string) {
  const input = field<HTMLInputElement>(label)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => useAppStore.setState({ loading: false, error: null, detectExecutors: async () => {}, checkHost: async () => {} }))

it('opens the real Goals submenu, keeps its draft, and saves exact reviewer and budget through the original owner', async () => {
  const f = await configOwnerFixture()
  await act(async () => useAppStore.setState({ config: f.owner.current }))
  let pending: ReturnType<typeof api.config.save> | undefined
  const write = vi.spyOn(api.config, 'save').mockImplementation((value, expected) => pending = f.owner.edit(expected!, value))
  const rpc = new AgentMuxRpcService({ execute: async request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Unexpected settings owner')
    return executeSettingsControl(request, f.owner)
  } })
  const call = async (args: string[]) => {
    const command = await parseSettingsCommand(args)
    return rpc.call(command.method, command.params, { transport: 'unix', principal: { kind: 'user', id: 'goal-workflow-proof' } })
  }

  await dom.render(<SettingsPanel initialSection="goals" onClose={() => {}} />)
  expect(dom.container.querySelector('[data-settings-field="goal-workflows"]')).toBeNull()
  await clickSettings('goals:goal-workflows')
  const surface = dom.container.querySelector<HTMLElement>('[data-settings-field="goal-workflows"]')!
  expect(surface.closest('[hidden]')).toBeNull()
  const template = field<HTMLSelectElement>('Default workflow template')
  await act(async () => { template.value = 'evidence-synthesis'; template.dispatchEvent(new Event('change', { bubbles: true })) })
  await fill('Reviewer Runtime ID', reviewer.runtimeId)
  expect(dom.container.querySelector<HTMLButtonElement>(saveSelector)?.disabled).toBe(true)
  await fill('Reviewer Session ID', reviewer.sessionId)
  await fill('Concurrent dispatches', '2')
  await fill('New attempts', '5')
  await clickSettings('goals')
  expect(surface.closest('[hidden]')).not.toBeNull()
  await clickSettings('goals:goal-workflows')
  expect(field<HTMLInputElement>('New attempts').value).toBe('5')
  expect(f.owner.current.goals).toBeUndefined()

  await dom.click(saveSelector)
  await act(async () => { await pending })
  expect(write).toHaveBeenCalledTimes(1)
  expect((await new ConfigStore(f.store.filePath).readSaved()).goals?.workflow).toEqual({
    template: 'evidence-synthesis', reviewerHostId: 'local', reviewerRuntimeId: reviewer.runtimeId,
    reviewerSessionId: reviewer.sessionId, maxConcurrent: 2, maxAttempts: 5
  })
  expect(await call(['inspect', 'goals.workflow'])).toMatchObject({ entries: [
    { key: 'goals.workflow.template', value: 'evidence-synthesis' },
    { key: 'goals.workflow.reviewer', value: JSON.stringify(reviewer) },
    { key: 'goals.workflow.maxConcurrent', value: 2 },
    { key: 'goals.workflow.maxAttempts', value: 5 }
  ] })
  await expect(call(['set', 'goals.workflow.reviewer', '{"sessionId":"incomplete"}'])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  await expect(call(['set', 'goals.workflow.maxConcurrent', '2.5'])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  await call(['set', 'goals.workflow.reviewer', ''])
  await act(async () => useAppStore.setState({ config: f.owner.current }))
  expect(field<HTMLInputElement>('Reviewer Session ID').value).toBe('')
  expect(field<HTMLInputElement>('Concurrent dispatches').value).toBe('2')
})

it('opens the exact workflow destination without materializing settings, and fences a concurrent reviewer edit as one value', async () => {
  const f = await configOwnerFixture()
  await act(async () => useAppStore.setState({ config: f.owner.current }))
  let pending: ReturnType<typeof api.config.save> | undefined
  const write = vi.spyOn(api.config, 'save').mockImplementation((value, expected) => pending = f.owner.edit(expected!, value))
  await dom.render(<SettingsPanel initialSection="goals" navigationRequest={{ section: 'goals', field: 'goal-workflow-budget' }} onClose={() => {}} />)
  expect(dom.container.querySelector('[data-settings-field="goal-workflow-budget"]')?.closest('[hidden]')).toBeNull()
  await clickSettings('goals')
  expect(field<HTMLInputElement>('Use the requesting Agent as Supervisor')?.closest('[hidden]')).toBeNull()
  await clickSettings('goals:goal-workflows')
  expect(write).not.toHaveBeenCalled()
  await fill('Reviewer Runtime ID', 'draft-runtime')
  await fill('Reviewer Session ID', 'draft-session')
  await f.owner.update(config => ({ ...config, goals: { ...config.goals, workflow: {
    reviewerHostId: 'remote-review', reviewerRuntimeId: 'updated-runtime', reviewerSessionId: 'updated-session'
  } } }))
  await act(async () => useAppStore.setState({ config: f.owner.current }))
  await dom.click(saveSelector)
  await act(async () => { await pending?.catch(() => undefined) })
  expect((await f.disk()).goals?.workflow).toEqual({
    reviewerHostId: 'remote-review', reviewerRuntimeId: 'updated-runtime', reviewerSessionId: 'updated-session'
  })
  expect(dom.container.querySelector('[data-settings-field="goal-workflows"] [role="alert"]')?.textContent ?? '').toContain('goals.workflow')
  expect(field<HTMLInputElement>('Reviewer Session ID').value).toBe('draft-session')
})
