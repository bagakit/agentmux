// @vitest-environment happy-dom
import { act, createElement, type MouseEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BrowserOutcomeCriteria } from '../src/renderer/src/components/BrowserOutcomeCriteria'
import { parseBrowserOutcomeCriteriaRequest, type BrowserOutcomeFieldRunInput } from '../src/shared/browser-outcome-criteria'
import { parseBrowserStructuredOutputRequest } from '../src/main/browser-structured-output'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

// Mounted production component/event/state/declaration consumer. happy-dom
// supplies clicks; Chromium standard radio keyboard defaults require Native.
async function mount() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const onRun = vi.fn(async (input: BrowserOutcomeFieldRunInput, _event: MouseEvent<HTMLButtonElement>) => {
    parseBrowserStructuredOutputRequest(input.request)
    parseBrowserOutcomeCriteriaRequest({ criteria: input.criteria })
  })
  await act(async () => root.render(createElement(BrowserOutcomeCriteria, { onRun })))
  const radios = () => [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
  const choose = async (type: string) => {
    const input = radios().find(radio => radio.value === type)
    expect(input).toBeDefined()
    await act(async () => input!.click())
  }
  const set = async (label: string, value: string) => {
    const field = [...host.querySelectorAll('label')].find(element => element.firstChild?.textContent?.trim() === label)?.querySelector('input')
    expect(field).toBeDefined()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
      field!.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const run = async () => { await act(async () => host.querySelector<HTMLButtonElement>('button')!.click()) }
  const close = async () => { await act(async () => root.unmount()); host.remove() }
  return { host, onRun, radios, choose, set, run, close }
}

describe('visible finite Browser outcome value types', () => {
  it.each([
    ['string', '', '', 'text'], ['number', '0', 0, 'text'], ['boolean', 'false', false, 'checked']
  ] as const)('mounted %s selection reaches the real finite declaration parser', async (type, text, expected, read) => {
    const f = await mount()
    try {
      expect(f.host.querySelector('fieldset legend')?.textContent).toBe('Value type')
      expect(f.radios().map(radio => [radio.value, radio.parentElement!.textContent?.trim(), radio.checked]))
        .toEqual([['string', 'Text', true], ['number', 'Number', false], ['boolean', 'Checked', false]])
      expect(f.host.querySelector('select')).toBeNull()
      await f.choose(type); await f.set('CSS selector', '#result'); await f.set('Equals', text); await f.run()
      expect(f.radios().filter(radio => radio.checked).map(radio => radio.value)).toEqual([type])
      expect(f.onRun).toHaveBeenCalledTimes(1)
      expect(f.onRun.mock.calls[0]![0]).toEqual({ request: { fields: [{ key: 'result', type, source: { selector: '#result', read } }] },
        criteria: [{ kind: 'field-equals', key: 'result', expected }] })
      expect(f.onRun.mock.calls[0]![1].nativeEvent.type).toBe('click')
      expect(f.host.querySelector('[role="status"]')).toBeNull()
    } finally { await f.close() }
  })

  it('two mounted Browser editors have independent native radio names, state and declared types', async () => {
    const first = await mount(), second = await mount()
    try {
      const names = [first, second].map(f => [...new Set(f.radios().map(radio => radio.name))])
      expect(names.map(group => group.length)).toEqual([1, 1])
      expect(names[0]![0]).toBeTruthy(); expect(names[1]![0]).toBeTruthy()
      expect(names[0]![0]).not.toBe(names[1]![0])
      await first.choose('number'); await second.choose('boolean')
      expect(first.radios().filter(radio => radio.checked).map(radio => radio.value)).toEqual(['number'])
      expect(second.radios().filter(radio => radio.checked).map(radio => radio.value)).toEqual(['boolean'])
      await first.set('CSS selector', '#number'); await first.set('Equals', '0'); await first.run()
      await second.set('CSS selector', '#flag'); await second.set('Equals', 'false'); await second.run()
      expect(first.onRun.mock.calls.map(call => [call[0].request.fields[0]!.type, call[0].criteria[0]]))
        .toEqual([['number', { kind: 'field-equals', key: 'result', expected: 0 }]])
      expect(second.onRun.mock.calls.map(call => [call[0].request.fields[0]!.type, call[0].criteria[0]]))
        .toEqual([['boolean', { kind: 'field-equals', key: 'result', expected: false }]])
    } finally { await first.close(); await second.close() }
  })

  it('invalid numeric and checked values retain the page/editor and start no producer', async () => {
    const f = await mount()
    try {
      await f.set('CSS selector', '#result'); await f.choose('number'); await f.set('Equals', 'false'); await f.run()
      expect(f.onRun).toHaveBeenCalledTimes(0)
      expect(f.host.querySelector('[role="status"]')?.textContent).toContain('declared type')
      await f.choose('boolean'); await f.set('Equals', '0'); await f.run()
      expect(f.onRun).toHaveBeenCalledTimes(0)
      expect(f.radios().filter(radio => radio.checked).map(radio => radio.value)).toEqual(['boolean'])
      expect(f.host.querySelector('details')).not.toBeNull()
    } finally { await f.close() }
  })
})
