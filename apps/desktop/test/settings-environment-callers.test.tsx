// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { ProjectRailToolbar } from '../src/renderer/src/components/ProjectRailToolbar'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()

it.each([false, true])('the actual Rail settings caller opens Overview (collapsed=%s)', async collapsed => {
  const open = vi.fn()
  await dom.render(<ProjectRailToolbar collapsed={collapsed} onOpenSettings={open} />)
  await dom.click('[aria-label="Settings"]')
  expect(open).toHaveBeenCalledExactlyOnceWith('overview')
  expect(dom.container.querySelector('[data-settings-section="workspaces"]')).toBeNull()
  await dom.click('[aria-label="Keyboard shortcuts"]')
  expect(open).toHaveBeenLastCalledWith('keyboard-shortcuts')
})
