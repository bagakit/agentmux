// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { FormRow } from '@agentmux/client-ui/components/FormRow'
import { NativeSelect } from '@agentmux/client-ui/input'
import { SettingsResourceLibrary } from '../src/renderer/src/components/settings/SettingsResourceLibrary'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()

it('retains the standard select focus, form value and field message', async () => {
  const change = vi.fn()
  const ref = vi.fn()
  await dom.render(<form>
    <FormRow label="Target" layout="stacked" description="Choose the original target." error="The selected target needs review." invalid>
      {field => <NativeSelect {...field} ref={ref} name="target" defaultValue="draft" onChange={change}>
        <option value="draft">Draft</option>
        <option value="original">Original target</option>
      </NativeSelect>}
    </FormRow>
  </form>)
  const form = dom.container.querySelector('form')!
  const select = form.querySelector('select')!
  expect(select.classList.contains('ui-input')).toBe(true)
  expect(ref.mock.calls.map(([node]) => node)).toContain(select)
  expect(new FormData(form).get('target')).toBe('draft')
  expect(select.labels?.[0]?.innerText).toContain('Target')
  expect(select.getAttribute('aria-invalid')).toBe('true')
  const messages = select.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent)
  expect(messages).toEqual(['Choose the original target.', 'The selected target needs review.'])
  await act(async () => {
    select.focus()
    select.value = 'original'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(document.activeElement).toBe(select)
  expect(change).toHaveBeenCalledOnce()
  expect(new FormData(form).get('target')).toBe('original')
})

it('clears the actual Settings resource query and returns the original search field', async () => {
  const change = vi.fn()
  const render = (query: string) => dom.render(<SettingsResourceLibrary label="Targets" items={[]} selectedId={null}
    query={query} onQuery={change} onSelect={vi.fn()} focusRequest={null} />)
  await render('original')
  const input = dom.container.querySelector('input')!
  const clear = dom.container.querySelector<HTMLButtonElement>('[aria-label="Clear targets filter"]')!
  expect(input.type).toBe('search')
  expect(clear).not.toBeNull()
  await act(async () => { clear.focus(); clear.click() })
  expect(change).toHaveBeenCalledExactlyOnceWith('')
  expect(document.activeElement).toBe(input)
  await render('')
  expect(dom.container.querySelector('input')).toBe(input)
  expect(dom.container.querySelector('[aria-label="Clear targets filter"]')).toBeNull()
})
