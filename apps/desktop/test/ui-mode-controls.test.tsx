// @vitest-environment happy-dom
import { act, useState } from 'react'
import { expect, it } from 'vitest'
import { FocusViewSwitch } from '../src/renderer/src/components/FocusViewSwitch'
import { NotebookViewPicker, type NotebookDirectoryView } from '../src/renderer/src/components/NotebookViews'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const buttons = () => [...dom.container.querySelectorAll<HTMLButtonElement>('button')]

it('keeps Focus as native pressed buttons with its original controlled selection and draft', async () => {
  useAppStore.setState({ focusView: 'list' })
  const draft = useAppStore.getState().agentComposerDrafts
  await dom.render(<form><FocusViewSwitch /><textarea defaultValue="Original unsent work" /></form>)
  const group = dom.container.querySelector('[aria-label="Focus view"]')!
  const editor = dom.container.querySelector('textarea')!
  expect(group.getAttribute('role')).toBe('group')
  expect(group.querySelector('[role="tab"]')).toBeNull()
  expect(buttons().map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
  expect(buttons().map(button => button.tabIndex)).toEqual([0, 0])
  expect(buttons().map(button => button.type)).toEqual(['button', 'button'])
  const arrow = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
  await act(async () => { buttons()[0]!.focus(); buttons()[0]!.dispatchEvent(arrow) })
  expect(arrow.defaultPrevented).toBe(false)
  expect(useAppStore.getState().focusView).toBe('list')
  await act(async () => buttons()[1]!.click())
  expect(useAppStore.getState().focusView).toBe('map')
  expect(buttons().map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
  expect(buttons().every(button => !button.hasAttribute('aria-selected'))).toBe(true)
  expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
  expect(dom.container.querySelector('textarea')).toBe(editor)
  expect(editor.value).toBe('Original unsent work')
})

it('keeps the actual Notebook picker as tabs and allows explicit selection while decoration is inactive', async () => {
  function Notebook() {
    const [view, setView] = useState<NotebookDirectoryView>('tree')
    return <><NotebookViewPicker value={view} onChange={setView} active={false} /><output>{view}</output></>
  }
  await dom.render(<Notebook />)
  const group = dom.container.querySelector('[aria-label="Notebook presentation"]')!
  expect(group.getAttribute('role')).toBe('tablist')
  expect(buttons().map(button => button.getAttribute('role'))).toEqual(['tab', 'tab', 'tab'])
  expect(buttons().map(button => button.tabIndex)).toEqual([0, -1, -1])
  await act(async () => {
    buttons()[0]!.focus()
    buttons()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
  })
  expect(dom.container.querySelector('output')!.textContent).toBe('graph')
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Graph view')
  expect(buttons().map(button => button.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true'])
  expect(buttons().every(button => !button.hasAttribute('aria-pressed'))).toBe(true)
  await act(async () => buttons()[0]!.click())
  expect(dom.container.querySelector('output')!.textContent).toBe('tree')
})
