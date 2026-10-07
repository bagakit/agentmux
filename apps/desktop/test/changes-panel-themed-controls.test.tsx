// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountThemeRuntime, previewTheme, GRAPHITE_THEME } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { ChangesPanel } from '../src/renderer/src/components/ChangesPanel'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
const dom = composerDOM()
let cleanup: () => void
const workspace = composerConfig.workspaces[0]!
beforeEach(() => { cleanup = mountThemeRuntime(window) })
afterEach(() => { cleanup(); delete window.agentmux })
it('shows Stage plus and Unstage minus from exact native Git facts and preserves workspace/path actions under icon override', async () => {
  const stage = vi.fn(async () => {}), unstage = vi.fn(async () => {})
  const status = vi.fn(async () => ({ kind: 'git-repository' as const, hostId: workspace.hostId, repoPath: workspace.path, repoRelativePrefix: '', branch: 'main', changes: [
    { path: 'original-working.ts', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false },
    { path: 'original-staged.ts', origPath: null, index: 'M', worktree: ' ', staged: true, unstaged: false, untracked: false }
  ] }))
  // Only the native Git transport is replaced. The real hook, Store, controls and theme owner run.
  window.agentmux = { git: { status, stage, unstage } } as unknown as typeof window.agentmux
  await dom.render(<ChangesPanel workspace={workspace} />)
  const add = dom.container.querySelector<HTMLButtonElement>('[aria-label="Stage original-working.ts"]')!
  const subtract = dom.container.querySelector<HTMLButtonElement>('[aria-label="Unstage original-staged.ts"]')!
  expect(add, 'actual Stage consumer').not.toBeNull(); expect(subtract, 'actual Unstage consumer').not.toBeNull()
  expect(add.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('git.stage'))
  expect(subtract.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('git.unstage'))
  const stageSymbol = document.getElementById(semanticIconHref('git.stage').slice(1))!
  expect(stageSymbol.querySelector('path[d="M12 5v14"]')).not.toBeNull()
  expect(stageSymbol.querySelector('path[d="M5 12h14"]')).not.toBeNull()
  expect(document.getElementById(semanticIconHref('git.unstage').slice(1))!.querySelector('path[d="M5 12h14"]')).not.toBeNull()
  const custom = structuredClone(GRAPHITE_THEME)
  custom.id = 'custom.git-control-proof'; custom.name = 'Git controls'
  custom.icons = { 'git.stage': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z', fill: 'currentColor' }] } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(dom.container.querySelector('[aria-label="Stage original-working.ts"]')).toBe(add)
  expect(document.getElementById(semanticIconHref('git.stage').slice(1))!.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  expect(add.disabled).toBe(false); expect(subtract.disabled).toBe(false)
  await act(async () => add.click()); expect(stage).toHaveBeenCalledWith(workspace.id, 'original-working.ts')
  await act(async () => subtract.click()); expect(unstage).toHaveBeenCalledWith(workspace.id, 'original-staged.ts')
})
it('remote Git actions expose exact verbs, keep individual role overrides and dispatch the original workspace', async () => {
  let finish!: (value: { kind: 'ok' }) => void
  const pull = vi.fn(() => new Promise<{kind:'ok'}>(resolve => { finish = resolve })), push = vi.fn(async () => ({ kind: 'ok' as const })), fetch = vi.fn(async () => ({ kind: 'ok' as const }))
  const status = vi.fn(async () => ({ kind: 'git-repository' as const, hostId: workspace.hostId, repoPath: workspace.path, repoRelativePrefix: '', branch: 'main', changes: [] }))
  window.agentmux = { git: { status, pull, push, fetch } } as unknown as typeof window.agentmux
  await dom.render(<ChangesPanel workspace={workspace} />)
  const pullButton = dom.container.querySelector<HTMLButtonElement>('[aria-label="Pull from remote"]')!, pushButton = dom.container.querySelector<HTMLButtonElement>('[aria-label="Push to remote"]')!
  expect(pullButton, 'actual remote Git consumer').not.toBeNull(); expect(pushButton).not.toBeNull()
  expect(pullButton.textContent).toBe('Pull'); expect(pushButton.textContent).toBe('Push')
  expect(pullButton.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('git.pull'))
  expect(pushButton.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('git.push'))
  const theme = structuredClone(GRAPHITE_THEME); theme.id = 'custom.git-pull'; theme.name = 'Only pull'
  theme.icons = { 'git.pull': { kind: 'paths', paths: [{ d: 'M3 5H21V19H3Z' }] } }
  await act(async () => { expect(previewTheme(theme).applied).toBe(true) })
  expect(document.getElementById(semanticIconHref('git.push').slice(1))?.querySelector('path')?.getAttribute('d')).not.toBe('M3 5H21V19H3Z')
  expect(dom.container.querySelector('[aria-label="Pull from remote"]')).toBe(pullButton)
  await act(async () => pullButton.click()); expect(pull).toHaveBeenCalledExactlyOnceWith(workspace.id)
  expect(pullButton.querySelector('[data-icon-animation="spin"]')).not.toBeNull(); expect(pullButton.textContent).toBe('Pull')
  expect(pushButton.disabled).toBe(true)
  await act(async () => finish({kind:'ok'})); expect(pullButton.querySelector('[data-icon-animation]')).toBeNull()
  await act(async () => pushButton.click()); expect(push).toHaveBeenCalledExactlyOnceWith(workspace.id); expect(fetch).not.toHaveBeenCalled()
})

it('tracked discard and untracked deletion keep their original two-step confirmation and exact native targets', async () => {
  const discard = vi.fn(async () => {}), status = vi.fn(async () => ({ kind: 'git-repository' as const, hostId: workspace.hostId, repoPath: workspace.path, repoRelativePrefix: '', branch: 'main', changes: [
    { path: 'tracked.md', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false },
    { path: 'untracked.md', origPath: null, index: '?', worktree: '?', staged: false, unstaged: true, untracked: true }
  ] }))
  window.agentmux = { git: { status, discard } } as unknown as typeof window.agentmux
  await dom.render(<ChangesPanel workspace={workspace} />)
  for (const [path, role, untracked] of [['tracked.md', 'git.discard-changes', false], ['untracked.md', 'action.remove', true]] as const) {
    const button = dom.container.querySelector<HTMLButtonElement>(`[aria-label="Discard ${path}"]`)!
    expect(button, 'actual discard consumer').not.toBeNull(); expect(button.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref(role))
    const before = discard.mock.calls.length
    await act(async () => button.click()); expect(discard).toHaveBeenCalledTimes(before)
    expect(button.getAttribute('aria-label')).toBe(`Confirm discard ${path}`); expect(button.title).toContain('cannot be undone')
    expect(button.classList.contains('change-row__discard--armed')).toBe(true)
    await act(async () => button.click()); expect(discard).toHaveBeenLastCalledWith(workspace.id, path, untracked)
  }
  expect(discard).toHaveBeenCalledTimes(2)
})
