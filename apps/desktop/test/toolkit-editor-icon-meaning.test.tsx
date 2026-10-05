const { fixturePath: _reshape_fixturePath } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
import { createRef } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { ToolkitToolEditor } from '../src/renderer/src/components/settings/ToolkitToolEditor'
import { composerDOM } from './helpers/composer-dom-fixture'

// The code editor is a separate adapter. These controls, assets, sprite and handlers are production implementations.
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => null }))
const dom = composerDOM()
let cleanup: () => void
beforeEach(() => { cleanup = mountThemeRuntime(window) })
afterEach(() => cleanup())
it('adds an argument with a plus and cancels an unsaved tool without presenting deletion', async () => {
  const edit = vi.fn(), remove = vi.fn(async () => true), back = vi.fn(), save = vi.fn(), run = vi.fn(async () => 'run')
  const value = { name: 'Local test tool', icon: 'terminal' as const, enabled: true, statusBar: 'icon' as const, workspacePath: _reshape_fixturePath("private/tmp/toolkit-icon-proof"), script: 'console.log(1)', args: ['original'] }
  await dom.render(<ToolkitToolEditor id="tool-proof" entry={{ value, expected: null, saving: false, state: 'idle', error: '', missing: false }} active nameInput={createRef()} save={{ state: 'idle', error: '', saving: false, run: async operation => { await operation(); return true } }} onEdit={edit} onSave={save} onRemove={remove} onRun={run} onBack={back} />)
  const add = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent?.trim() === 'Add argument')!
  const cancel = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent?.trim() === 'Cancel new tool')!
  expect(add.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.add-argument'))
  const addSymbol = document.getElementById(semanticIconHref('action.add-argument').slice(1))!
  expect(addSymbol.querySelector('path[d="M12 5v14"]')).not.toBeNull()
  expect(addSymbol.querySelector('path[d="M5 12h14"]')).not.toBeNull()
  expect(cancel.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.cancel'))
  await dom.click('.toolkit-editor__arguments > summary')
  await dom.click('.toolkit-editor__arguments > button')
  expect(edit).toHaveBeenCalledWith({ args: ['original', ''] })
  await dom.click('.toolkit-editor__footer > button')
  expect(remove).toHaveBeenCalledOnce()
  expect(back).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})
