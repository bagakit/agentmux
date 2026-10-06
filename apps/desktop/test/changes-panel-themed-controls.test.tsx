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
