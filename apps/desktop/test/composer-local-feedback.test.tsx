// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, MAX_AGENT_STEER_QUEUE_ENTRIES, executorDetectionKey } from '../src/renderer/src/store'
import { MAX_AGENT_PROMPT_BYTES } from '@agentmux/core/agent-prompt-budget'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const failure = () => dom.container.querySelector('.composer-feedback')
const retry = '.composer-feedback button:first-of-type'

it('keeps file errors next to the Session draft, retries, and appends every chosen file to the latest draft', async () => {
  const choose = vi.spyOn(api.ui, 'chooseFiles').mockRejectedValueOnce(new Error('Picker unavailable')).mockResolvedValueOnce(['/repo/a.ts', '/repo/b.ts'])
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-tool--mode')
  await dom.click('[aria-label="Reference files for the Agent to read"]')
  expect(failure()?.textContent).toContain('Picker unavailable')
  expect(dom.draft()).toBe('Keep my draft')
  expect(useAppStore.getState().error).toBeNull()
  await act(async () => useAppStore.getState().setAgentComposerDraft('agent-1', 'Edited after failure'))
  await dom.click(retry)
  expect(choose).toHaveBeenCalledTimes(2)
  expect(dom.draft()).toContain('Edited after failure')
  expect(dom.draft()).toContain('@a.ts')
  expect(dom.draft()).toContain('@b.ts')
  expect(failure()).toBeNull()
})

it('pasted-image failures are visible locally and retry the same image without losing the draft', async () => {
  const save = vi.spyOn(api.ui, 'savePastedImage').mockRejectedValueOnce(new Error('Disk full')).mockResolvedValueOnce('/repo/pasted.png')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const file = new File([new Uint8Array([1, 2, 3])], 'paste.png', { type: 'image/png' })
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], getData: () => '' } })
  await act(async () => dom.container.querySelector('.tiptap')!.dispatchEvent(event))
  await vi.waitFor(() => expect(failure()?.textContent).toContain('Disk full'))
  expect(dom.draft()).toBe('Keep my draft')
  expect(useAppStore.getState().error).toBeNull()
  await dom.click(retry)
  expect(save).toHaveBeenCalledTimes(2)
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0])
  expect(dom.draft()).toContain('@pasted.png')
  expect(failure()).toBeNull()
})

it('capture failure stays local, can fail repeatedly, and cancellation preserves the draft', async () => {
  const capture = vi.spyOn(api.ui, 'captureScreenshot').mockRejectedValueOnce(new Error('Capture unavailable')).mockRejectedValueOnce(new Error('Still unavailable')).mockResolvedValueOnce(null)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-tool--mode')
  await dom.click('[aria-label="Capture a screen region"]')
  expect(failure()?.textContent).toContain('Capture unavailable')
  await dom.click(retry)
  expect(failure()?.textContent).toContain('Still unavailable')
  await dom.click(retry)
  expect(capture).toHaveBeenCalledTimes(3)
  expect(dom.draft()).toBe('Keep my draft')
  expect(failure()).toBeNull()
  expect(useAppStore.getState().error).toBeNull()
})

it('skill discovery failure remains visible after the menu closes and retry discovers real choices', async () => {
  const discover = vi.spyOn(api.ui, 'listAgentSkills').mockRejectedValueOnce(new Error('Skill folders unavailable')).mockResolvedValueOnce([{ name: 'Review', path: '/skills/review/SKILL.md', source: 'workspace', description: 'Review changes' }])
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-tool--mode')
  await act(async () => dom.container.querySelector('[aria-label="Choose a skill"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })))
  expect(failure()?.textContent).toContain('Skill folders unavailable')
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(failure()?.textContent).toContain('Skill folders unavailable')
  await dom.click(retry)
  expect(discover).toHaveBeenCalledTimes(2)
  expect(failure()).toBeNull()
  expect(useAppStore.getState().error).toBeNull()
  expect(dom.draft()).toBe('Keep my draft')
})

it.each(['oversized', 'full queue'] as const)('reports %s admission locally and preserves the exact draft', async (reason) => {
  const draft = reason === 'oversized' ? 'x'.repeat(MAX_AGENT_PROMPT_BYTES + 1) : 'Refused queue draft'
  useAppStore.setState({ agentComposerDrafts: { 'agent-1': draft }, agentSteerQueues: reason === 'full queue' ? {
    'agent-1': Array.from({ length: MAX_AGENT_STEER_QUEUE_ENTRIES }, (_, index) => ({ operationId: `op-${index}`, text: 'queued', runId: 'run-agent-1', status: 'queued' as const }))
  } : {} })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-send')
  expect(failure()?.textContent).toMatch(reason === 'oversized' ? /too large/ : /queue is full/)
  expect(dom.draft()).toBe(draft)
  expect(useAppStore.getState().error).toBeNull()
  await dom.click('[aria-label="Dismiss message tool error"]')
  expect(failure()).toBeNull()
  expect(dom.draft()).toBe(draft)
})

async function launcher() {
  useAppStore.setState({ tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) }, activeWorkspaceId: 'workspace', agentComposerDrafts: { region: 'Launch draft' } })
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
}
it('Launcher exposes usable tools without a dead layout toggle; multi-selection keeps all files and intervening edits', async () => {
  let resolve!: (paths: string[]) => void
  vi.spyOn(api.ui, 'chooseFiles').mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  await launcher()
  expect(dom.container.querySelector('.composer-tool--mode')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Choose a skill"]')).not.toBeNull()
  await dom.click('[aria-label="Reference files for the Agent"]')
  await act(async () => useAppStore.getState().setAgentComposerDraft('region', 'Newer launch draft'))
  await act(async () => resolve(['/repo/a.ts', '/repo/b.ts']))
  expect(dom.draft('region')).toContain('Newer launch draft')
  expect(dom.draft('region')).toContain('@a.ts')
  expect(dom.draft('region')).toContain('@b.ts')
})
it('Launcher picker failure is retryable in place; cancellation leaves its prompt intact', async () => {
  const choose = vi.spyOn(api.ui, 'chooseFiles').mockRejectedValueOnce(new Error('Launcher picker failed')).mockResolvedValueOnce(null)
  await launcher()
  await dom.click('[aria-label="Reference files for the Agent"]')
  expect(failure()?.textContent).toContain('Launcher picker failed')
  expect(dom.draft('region')).toBe('Launch draft')
  await dom.click(retry)
  expect(choose).toHaveBeenCalledTimes(2)
  expect(failure()).toBeNull()
  expect(dom.draft('region')).toBe('Launch draft')
  expect(useAppStore.getState().error).toBeNull()
})

it('success from the original Capture button clears the previous error', async () => {
  vi.spyOn(api.ui, 'captureScreenshot').mockRejectedValueOnce(new Error('First capture failed')).mockResolvedValueOnce('/repo/capture.png')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-tool--mode')
  await dom.click('[aria-label="Capture a screen region"]')
  expect(failure()?.textContent).toContain('First capture failed')
  await dom.click('[aria-label="Capture a screen region"]')
  expect(failure()).toBeNull()
  expect(dom.draft()).toContain('@capture.png')
})
async function openSkills() {
  await act(async () => dom.container.querySelector('[aria-label="Choose a skill"]')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, buttons: 0, button: 0, pointerType: 'mouse' })))
}
async function closeSkills() {
  await act(async () => document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
}
it('reopening Skills successfully clears its previous error outside the menu', async () => {
  vi.spyOn(api.ui, 'listAgentSkills').mockRejectedValueOnce(new Error('First discovery failed')).mockResolvedValueOnce([])
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-tool--mode')
  await openSkills()
  expect(failure()?.textContent).toContain('First discovery failed')
  await closeSkills()
  await openSkills()
  expect(failure()).toBeNull()
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('No skills found')
})
it('two tool results in one React batch both append to the Launcher draft', async () => {
  let files!: (paths: string[]) => void
  let capture!: (path: string) => void
  vi.spyOn(api.ui, 'chooseFiles').mockImplementationOnce(() => new Promise((done) => { files = done }))
  vi.spyOn(api.ui, 'captureScreenshot').mockImplementationOnce(() => new Promise((done) => { capture = done }))
  await launcher()
  await dom.click('[aria-label="Reference files for the Agent"]')
  await dom.click('[aria-label="Capture a screen region"]')
  await act(async () => { files(['/repo/a.ts', '/repo/b.ts']); capture('/repo/screen.png') })
  expect(dom.draft('region')).toContain('Launch draft')
  expect(dom.draft('region')).toContain('@a.ts')
  expect(dom.draft('region')).toContain('@b.ts')
  expect(dom.draft('region')).toContain('@screen.png')
})
async function twoProviderLauncher() {
  const config = useAppStore.getState().config!
  useAppStore.setState({ config: { ...config, executors: { ...config.executors,
    claude: { ...config.executors.codex!, providerId: 'claude', command: 'claude', label: 'Claude' }
  } }, executorDetections: { [executorDetectionKey('local', 'codex')]: { state: 'ready' }, [executorDetectionKey('local', 'claude')]: { state: 'ready' } } })
  await launcher()
}
async function selectClaude() {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('.agent-pick')].find((b) => b.textContent?.includes('Claude'))
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
it('switching Provider removes the old Retry and discovers skills for the new Provider', async () => {
  const discover = vi.spyOn(api.ui, 'listWorkspaceSkills').mockRejectedValueOnce(new Error('Old provider failed')).mockResolvedValueOnce([])
  await twoProviderLauncher()
  await openSkills()
  expect(failure()?.textContent).toContain('Old provider failed')
  await closeSkills()
  await selectClaude()
  expect(failure()).toBeNull()
  await openSkills()
  expect(discover.mock.calls).toEqual([['workspace', 'codex'], ['workspace', 'claude']])
})
it.each(['resolve', 'reject'] as const)('old Provider %s cannot replace new skills or feedback', async (outcome) => {
  let resolve!: (skills: never[]) => void
  let reject!: (error: Error) => void
  const discover = vi.spyOn(api.ui, 'listWorkspaceSkills').mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no }))
    .mockResolvedValueOnce([{ name: 'New provider skill', description: '', path: '/skills/new/SKILL.md', source: 'project' }])
  await twoProviderLauncher()
  await openSkills()
  expect(discover).toHaveBeenCalledWith('workspace', 'codex')
  await closeSkills()
  await selectClaude()
  await openSkills()
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('New provider skill')
  await act(async () => { if (outcome === 'resolve') resolve([]); else reject(new Error('Old request failed late')) })
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('New provider skill')
  expect(failure()).toBeNull()
})
it('a late old-Provider failure cannot erase the new Provider error', async () => {
  let reject!: (error: Error) => void
  vi.spyOn(api.ui, 'listWorkspaceSkills').mockImplementationOnce(() => new Promise((_yes, no) => { reject = no }))
    .mockRejectedValueOnce(new Error('Current provider failed'))
  await twoProviderLauncher()
  await openSkills()
  await closeSkills()
  await selectClaude()
  await openSkills()
  expect(failure()?.textContent).toContain('Current provider failed')
  await act(async () => reject(new Error('Old request failed late')))
  expect(failure()?.textContent).toContain('Current provider failed')
})

async function selectCodex() {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('.agent-pick')].find((b) => b.textContent?.includes('Codex'))
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
it('returning to the original Provider does not resurrect its old error or Retry', async () => {
  vi.spyOn(api.ui, 'listWorkspaceSkills').mockRejectedValueOnce(new Error('Old A failure'))
  await twoProviderLauncher()
  await openSkills()
  expect(failure()?.textContent).toContain('Old A failure')
  await closeSkills()
  await selectClaude()
  await selectCodex()
  expect(failure()).toBeNull()
})
it('an old A request cannot overwrite the new A error after A→B→A', async () => {
  let reject!: (error: Error) => void
  vi.spyOn(api.ui, 'listWorkspaceSkills').mockImplementationOnce(() => new Promise((_yes, no) => { reject = no }))
    .mockRejectedValueOnce(new Error('Current A failure'))
  await twoProviderLauncher()
  await openSkills()
  await closeSkills()
  await selectClaude()
  await selectCodex()
  await openSkills()
  expect(failure()?.textContent).toContain('Current A failure')
  await act(async () => reject(new Error('Old A failure late')))
  expect(failure()?.textContent).toContain('Current A failure')
})
