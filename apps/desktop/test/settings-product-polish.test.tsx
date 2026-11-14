import { win32 as _hygiene_win32 } from "node:path"
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { AgentSettingsPane } from '../src/renderer/src/components/settings/AgentSettingsPane'
import { HostProjectsPane } from '../src/renderer/src/components/settings/HostProjectsPane'
import { executorEnvironmentRevision } from '../src/shared/executor-probe-context'
import { settingsNavGroups } from '../src/renderer/src/components/settings/settings-modules'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore, executorDetectionKey } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const config = { ...composerConfig, executors: {
  ...composerConfig.executors,
  reviewer: { ...composerConfig.executors.codex!, label: 'Reviewer', args: ['--model', 'review model'], env: { REVIEW: 'keep=this' } }
} }
beforeEach(async () => {
  useAppStore.setState({ config, providerCatalog: await api.providers.list(), hostChecks: { local: { state: 'ready', detail: 'Ready' } },
    executorDetections: {}, hostExecutorInventories: {}, detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}) })
})
async function fill(selector: string, value: string) {
  const node = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  expect(node).not.toBeNull()
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function category(title: string) {
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Settings section"]')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const choices = [...document.querySelectorAll<HTMLElement>('.settings-section-menu [role="menuitemradio"]')]
  expect(choices.map(node => node.textContent)).toEqual(['Overview', ...settingsNavGroups('').flatMap(group => group.items.map(item => item.title))])
  const item = choices.find(node => node.textContent === title)!
  expect(item).not.toBeUndefined()
  await act(async () => item.click())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
}

it('finds one of 51 Host projects by path, preserves folder drafts, and distinguishes no matches from no resources', async () => {
  const large = { ...config, workspaces: Array.from({ length: 51 }, (_, index) => ({
    ...composerConfig.workspaces[0]!, id: `w-${index}`, name: `Project ${index}`, path: (_hygiene_fixturePath("projects/repository-") + (index) + "")
  })) }
  await dom.render(<HostProjectsPane config={large} hostId="local" connectionChanged={false} active hidden={false} />)
  expect(dom.container.querySelectorAll('.host-projects__list [data-registered-folder]')).toHaveLength(51)
  await dom.click('.host-projects__heading button')
  await fill('[placeholder="Project directory"]', _hygiene_fixturePath("unsaved-project"))
  await fill('[aria-label="Find a project on This Mac"]', 'REPOSITORY-50')
  expect([...dom.container.querySelectorAll('.host-projects__list [data-registered-folder] strong')].map(node => node.textContent)).toEqual(['Project 50'])
  await fill('[aria-label="Find a project on This Mac"]', 'nothing-matches')
  expect(dom.container.querySelector('.settings-resource-empty[role="status"]')!.textContent).toContain('No projects match')
  expect(dom.container.querySelector<HTMLInputElement>('[placeholder="Project directory"]')!.value).toBe(_hygiene_fixturePath("unsaved-project"))
  const clear = dom.container.querySelector<HTMLButtonElement>('[aria-label="Clear project filter"]')
  expect(clear, 'The Host project query exposes an explicit clear action').not.toBeNull()
  await act(async () => clear!.click())
  expect(document.activeElement).toBe(dom.container.querySelector('[aria-label="Find a project on This Mac"]'))
  expect(dom.container.querySelectorAll('.host-projects__list [data-registered-folder]')).toHaveLength(51)
})

it('keeps the same open editor, native focus, and draft when availability changes and filtering narrows its library', async () => {
  await dom.render(<AgentSettingsPane config={config} onSave={async () => {}} executorId="reviewer" />)
  const card = dom.container.querySelector<HTMLElement>('#executor-settings-reviewer')!
  const name = card.querySelector<HTMLInputElement>('[data-executor-name]')!
  expect(card.dataset.resourceEditor).toBe('reviewer')
  await fill('#executor-settings-reviewer [data-executor-name]', 'My reviewer')
  await act(async () => name.focus())
  const input = { executorId: 'reviewer', providerId: config.executors.reviewer.providerId, command: config.executors.reviewer.command,
    environmentRevision: executorEnvironmentRevision(config.executors.reviewer.env), host: config.hosts[0]! }
  await act(async () => useAppStore.setState({ executorDetections: {
    [executorDetectionKey('local', 'reviewer')]: { state: 'ready', input, result: { input, executable: input.command, availability: 'available' } }
  } }))
  expect(card.querySelector('.check-pill')!.textContent).toBe('Available')
  expect(dom.container.querySelector('#executor-settings-reviewer')).toBe(card)
  expect(card.dataset.resourceEditor).toBe('reviewer')
  expect(document.activeElement).toBe(name)
  expect(name.value).toBe('My reviewer')
  await fill('[aria-label="Filter executors"]', 'no-match')
  expect(card.hidden).toBe(false)
  expect(dom.container.querySelectorAll('[aria-label="Executors"] [data-resource-row]')).toHaveLength(0)
  expect(dom.container.querySelector('[aria-label="Executors"] .settings-resource-empty[role="status"]')!.textContent).toContain('No executors match')
  await fill('[aria-label="Filter executors"]', 'REVIEWER')
  expect(card.hidden).toBe(false)
  expect(card.querySelector('[data-executor-name]')).toBe(name)
  expect(name.value).toBe('My reviewer')
  await fill('[aria-label="Filter executors"]', 'My reviewer')
  await fill('#executor-settings-reviewer [data-executor-name]', 'Renamed while found')
  expect(card.hidden).toBe(false)
  expect(name.value).toBe('Renamed while found')
})

it('saves common edits without dropping closed launch configuration and keeps immutable identity out of editable controls', async () => {
  const save = vi.fn(async () => {})
  await dom.render(<AgentSettingsPane config={config} onSave={save} executorId="reviewer" />)
  const card = dom.container.querySelector('#executor-settings-reviewer')!
  expect(card.querySelector<HTMLDetailsElement>('.settings-launch-config')!.open).toBe(false)
  expect(card.querySelector('.settings-executor-identity')!.textContent).toContain('ProviderCodexExecutor IDreviewer')
  expect(card.querySelectorAll('.settings-executor-identity input, .settings-executor-identity select')).toHaveLength(0)
  await fill('#executor-settings-reviewer [data-executor-name]', 'Named review')
  await dom.click('.settings-pane-actions button')
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...config.executors, reviewer: { ...config.executors.reviewer, label: 'Named review' } }, config.executors)
  expect(dom.container.querySelector('[data-settings-save-bar] [role="status"]')!.textContent).toContain('Changes saved')
})

it('creates a reachable focused editor, leaves existing IDs unchanged and allows Provider selection only for the new executor', async () => {
  const existing = structuredClone(config.executors)
  await dom.render(<AgentSettingsPane config={config} onSave={async () => {}} />)
  await fill('[aria-label="Filter executors"]', 'not-found')
  const add = [...dom.container.querySelectorAll<HTMLButtonElement>('.settings-pane-toolbar button')].find(node => node.textContent?.trim() === 'Add executor')!
  expect(add).toBeDefined(); await act(async () => add.click())
  const added = () => dom.container.querySelector<HTMLElement>('[data-resource-editor]')!
  expect(added().dataset.resourceEditor).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
  const name = added().querySelector<HTMLInputElement>('[data-executor-name]')!
  expect(document.activeElement).toBe(name)
  expect([name.selectionStart, name.selectionEnd]).toEqual([0, name.value.length])
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Filter executors"]')!.value).toBe('')
  expect(added().querySelector('[data-executor-provider]')).not.toBeNull()
  expect(dom.container.querySelectorAll('.agent-settings-card')).toHaveLength(1)
  expect(dom.container.querySelectorAll('[aria-label="Executors"] [data-resource-row]')).toHaveLength(Object.keys(existing).length + 1)
  const choose = async (value: string) => act(async () => {
    const provider = added().querySelector<HTMLSelectElement>('[data-executor-provider]')!
    provider.value = value; provider.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await choose('claude')
  expect(added().querySelector<HTMLInputElement>('[aria-label="Executor executable"]')!.value).toBe('claude')
  await fill('[data-resource-editor] [aria-label="Executor executable"]', _hygiene_fixturePath("custom/claude"))
  await choose('codex')
  expect(added().querySelector<HTMLInputElement>('[aria-label="Executor executable"]')!.value).toBe(_hygiene_fixturePath("custom/claude"))
  expect(config.executors).toEqual(existing)
})

it('keeps edits and actionable failure feedback on a rejected save, then saves the same draft on retry', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('Disk could not be written')).mockResolvedValueOnce(undefined)
  await dom.render(<AgentSettingsPane config={config} onSave={save} executorId="reviewer" />)
  await fill('#executor-settings-reviewer [data-executor-name]', 'Keep this edit')
  await dom.click('.settings-pane-actions button')
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toBe('Disk could not be written')
  expect(dom.container.querySelector<HTMLInputElement>('#executor-settings-reviewer [data-executor-name]')!.value).toBe('Keep this edit')
  expect(dom.container.querySelector<HTMLButtonElement>('.settings-pane-actions button')!.disabled).toBe(false)
  await dom.click('.settings-pane-actions button')
  expect(save).toHaveBeenLastCalledWith({ ...config.executors, reviewer: { ...config.executors.reviewer, label: 'Keep this edit' } }, config.executors)
})

it('uses the complete grouped category picker and preserves executor drafts when changing sections', async () => {
  await dom.render(<SettingsPanel initialSection="agents" executorId="reviewer" onClose={() => {}} />)
  await fill('#executor-settings-reviewer [data-executor-name]', 'Preserved')
  await category('Browser')
  expect(dom.container.querySelector('.settings-content__header h2')!.textContent).toBe('Browser')
  await category('Agent CLIs')
  expect(dom.container.querySelector<HTMLInputElement>('#executor-settings-reviewer [data-executor-name]')!.value).toBe('Preserved')
  expect(dom.container.querySelector<HTMLElement>('#executor-settings-reviewer')!.dataset.resourceEditor).toBe('reviewer')
})

it('dismisses the category menu before closing Settings and returns focus to its trigger', async () => {
  const close = vi.fn()
  await dom.render(<SettingsPanel onClose={close} />)
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Settings section"]')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const menu = document.querySelector<HTMLElement>('.settings-section-menu[role="menu"]')!
  expect(menu).not.toBeNull()
  await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.settings-section-menu[role="menu"]')).toBeNull()
  expect(close).not.toHaveBeenCalled()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(document.activeElement).toBe(trigger)
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(close).toHaveBeenCalledOnce()
})

it('changes explicit launch posture without splitting literal argv or trimming untouched environment values', async () => {
  const special = { ...config, executors: { reviewer: { ...config.executors.reviewer,
    args: ['--model', 'review model', '--sandbox', 'read-only', '--literal', 'a\'b"c', ''], env: { VALUE: '  keep spaces  ' }
  } } }
  const save = vi.fn(async () => {})
  await dom.render(<AgentSettingsPane config={special} onSave={save} executorId="reviewer" />)
  await dom.click('#executor-settings-reviewer .settings-launch-action button')
  expect(save).toHaveBeenCalledExactlyOnceWith({ reviewer: { ...special.executors.reviewer,
    args: ['--model', 'review model', '--literal', 'a\'b"c', '', '--sandbox', 'danger-full-access', '--ask-for-approval', 'never']
  } }, special.executors)
})

it('appends an advanced argument without changing any existing literal argument', async () => {
  const args = ['--model', 'gpt 5', 'a\'b"c', '', _hygiene_win32.join("C:", _hygiene_win32.sep, "folder\\file"), '$TOKEN', '${TOKEN}', 'src/*.ts', '>']
  const special = { ...config, executors: { reviewer: { ...config.executors.reviewer, args } } }
  const save = vi.fn(async () => {})
  await dom.render(<AgentSettingsPane config={special} onSave={save} executorId="reviewer" />)
  await dom.click('#executor-settings-reviewer .settings-launch-config > summary')
  const selector = '#executor-settings-reviewer [aria-label="Executor arguments"]'
  const before = dom.container.querySelector<HTMLTextAreaElement>(selector)!.value
  expect(before).toContain("'gpt 5'")
  await fill(selector, `${before}\n--effort high`)
  await dom.click('.settings-pane-actions button')
  expect(save).toHaveBeenCalledExactlyOnceWith({ reviewer: { ...special.executors.reviewer, args: [...args, '--effort', 'high'] } }, special.executors)
})

it('keeps invalid quoted arguments as a draft and reports both save and explicit launch-action failures', async () => {
  const save = vi.fn(async () => {})
  await dom.render(<AgentSettingsPane config={config} onSave={save} executorId="reviewer" />)
  const selector = '#executor-settings-reviewer [aria-label="Executor arguments"]'
  await fill(selector, '--model "unfinished')
  await dom.click('.settings-pane-actions button')
  expect(save).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toMatch(/quote|quoting/i)
  await dom.click('#executor-settings-reviewer .settings-launch-action button')
  expect(save).not.toHaveBeenCalled()
  expect(dom.container.querySelector<HTMLTextAreaElement>(selector)!.value).toBe('--model "unfinished')
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toMatch(/quote|quoting/i)
})
