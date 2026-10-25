// @vitest-environment happy-dom
import { act, createRef, useState } from 'react'
import { expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { FormRow } from '@agentmux/client-ui/components/FormRow'

const dom = composerDOM()
const cases = [
  { section: 'general', selector: '[data-settings-field="copy-paths"] .browser-automation-toggle', name: 'Show and copy full project paths', fieldName: 'copyPathsAsAbsolute', description: 'Include your complete home folder instead of ~.' },
  { section: 'notifications', selector: '[data-settings-field="notification-sound"] .notification-sound-toggle', name: 'Play the system notification sound', fieldName: 'sound', description: 'Applies to Agent status banners and enabled A2A message alerts. Silent by default.' }
] as const

async function ownerConsumer() {
  const f = await configOwnerFixture({ copyPathsAsAbsolute: false, notifications: { mode: 'off', sound: false } })
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(saved => { publish(saved); useAppStore.getState().setConfig(saved) })
  useAppStore.setState({ config: f.owner.current })
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => f.owner.edit(expected, next))
  return { ...f, uiSave: save }
}
function field(selector: string) {
  const input = dom.container.querySelector<HTMLInputElement>(selector + ' input')
  expect(input).not.toBeNull(); return input!
}

it.each(cases)('$section keeps its original native field and exact save expectation through failure and explicit retry', async ({ section, selector, name, fieldName, description }) => {
  const f = await ownerConsumer()
  await dom.render(<SettingsPanel initialSection={section} onClose={() => {}} />)
  const checkbox = field(selector), row = checkbox.closest('label')!
  const save = dom.container.querySelector<HTMLButtonElement>(`[data-settings-pane="${section}"] [data-settings-save-bar] button`)!
  const originalSessions = useAppStore.getState().sessions, originalDrafts = useAppStore.getState().agentComposerDrafts
  expect(checkbox.type).toBe('checkbox'); expect(checkbox.checked).toBe(false); expect(checkbox.disabled).toBe(false)
  expect(checkbox.name).toBe(fieldName); expect(row.htmlFor).toBe(checkbox.id); expect(checkbox.id).not.toBe('')
  expect(document.getElementById(checkbox.getAttribute('aria-labelledby')!)?.textContent).toBe(name)
  expect(document.getElementById(checkbox.getAttribute('aria-describedby')!)?.textContent).toBe(description)
  expect(checkbox.labels?.[0]).toBe(row); expect(checkbox.getAttribute('role')).toBeNull()
  expect(checkbox.hasAttribute('aria-invalid')).toBe(false); expect(save.disabled).toBe(true)
  await act(async () => row.querySelector('strong')!.click())
  expect(checkbox.checked).toBe(true); expect(f.uiSave).not.toHaveBeenCalled(); expect(save.disabled).toBe(false)
  const reply = deferred<void>()
  f.save.mockImplementationOnce(async () => { await reply.promise; throw new Error('The original preferences storage is unavailable') })
  await act(async () => save.click())
  expect(f.uiSave).toHaveBeenCalledTimes(1); expect(save.disabled).toBe(true)
  expect(checkbox.disabled, 'Saving does not revoke editing of the next draft').toBe(false)
  await act(async () => checkbox.click()); expect(checkbox.checked).toBe(false)
  await act(async () => checkbox.click()); expect(checkbox.checked).toBe(true)
  expect(f.uiSave).toHaveBeenCalledTimes(1)
  await act(async () => { reply.resolve(); await f.uiSave.mock.results[0]!.value.catch(() => {}) })
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe('The original preferences storage is unavailable')
  expect(field(selector)).toBe(checkbox); expect(checkbox.checked).toBe(true); expect(checkbox.disabled).toBe(false)
  expect(checkbox.hasAttribute('aria-invalid')).toBe(false); expect(save.disabled).toBe(false)
  expect((await f.disk()).copyPathsAsAbsolute).toBe(false)
  expect((await f.disk()).notifications).toEqual({ mode: 'off', sound: false })
  await act(async () => save.click())
  expect(f.uiSave).toHaveBeenCalledTimes(2)
  await act(async () => { await f.uiSave.mock.results[1]!.value })
  expect(f.uiSave.mock.calls[1]).toEqual(f.uiSave.mock.calls[0])
  const [next, expected] = f.uiSave.mock.calls[0]!
  if (section === 'general') {
    expect(next.copyPathsAsAbsolute).toBe(true); expect(expected.copyPathsAsAbsolute).toBe(false)
    expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
    expect(next.notifications).toEqual(expected.notifications)
  } else {
    expect(next.notifications).toEqual({ mode: 'off', sound: true })
    expect(expected.notifications).toEqual({ mode: 'off', sound: false })
    expect((await f.disk()).notifications).toEqual({ mode: 'off', sound: true })
    expect(next.copyPathsAsAbsolute).toBe(expected.copyPathsAsAbsolute)
  }
  expect(field(selector)).toBe(checkbox); expect(save.disabled).toBe(true)
  expect(dom.container.querySelector('[role="alert"]')).toBeNull()
  expect(useAppStore.getState().sessions).toBe(originalSessions); expect(useAppStore.getState().agentComposerDrafts).toBe(originalDrafts)
})

it('keeps the caller native control ref, explicit ID, name and disabled state without replacing the input', async () => {
  const inputRef = createRef<HTMLInputElement>(), changed = vi.fn()
  function Fields({ disabled = false }: { disabled?: boolean }) {
    const [checked, setChecked] = useState(false)
    return <FormRow controlId="retained-field" className="original-row" label="Original preference" description="Original description">
      {attributes => <input {...attributes} ref={inputRef} type="checkbox" name="original-preference" checked={checked} disabled={disabled}
        onChange={event => { changed(event.currentTarget.checked); setChecked(event.currentTarget.checked) }} />}
    </FormRow>
  }
  await dom.render(<Fields />)
  const input = dom.container.querySelector<HTMLInputElement>('input')!, row = input.closest('label')!
  expect(inputRef.current).toBe(input); expect(input.id).toBe('retained-field'); expect(input.name).toBe('original-preference')
  expect(row.className).toBe('original-row'); expect(row.htmlFor).toBe(input.id)
  input.focus(); expect(document.activeElement).toBe(input)
  await act(async () => row.querySelector('small')!.click())
  expect(changed.mock.calls).toEqual([[true]]); expect(input.checked).toBe(true)
  await dom.render(<Fields disabled />)
  expect(inputRef.current).toBe(input); expect(input.disabled).toBe(true)
  await act(async () => row.click())
  expect(changed.mock.calls).toEqual([[true]]); expect(input.checked).toBe(true)
})
