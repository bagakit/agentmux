// @vitest-environment happy-dom
import { act, createRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ComposerTextarea, InputGroup } from '@agentmux/client-ui/input'

let host: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

it('keeps the original controlled composition mirror through the shared native field and container', async () => {
  const fieldRef = createRef<HTMLTextAreaElement>(), groupRef = createRef<HTMLDivElement>(), writes = vi.fn()
  let externalWrite!: (value: string) => void
  function Draft() {
    const [value, setValue] = useState('Question')
    externalWrite = setValue
    return <InputGroup ref={groupRef} aria-label="Question and action">
      <label htmlFor="question">Question</label>
      <ComposerTextarea id="question" ref={fieldRef} value={value}
        onValueChange={next => { writes(next); setValue(next) }} />
      <button type="button">Prepare</button>
    </InputGroup>
  }
  await act(async () => root.render(<Draft />))
  const field = fieldRef.current!
  expect(field.tagName).toBe('TEXTAREA')
  expect(field.parentElement).toBe(groupRef.current)
  expect(field.labels?.[0]?.textContent).toBe('Question')
  const setDom = (value: string) => Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
  await act(async () => {
    field.focus(); setDom('候选'); field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  })
  await act(async () => externalWrite('External controlled update'))
  expect(document.activeElement).toBe(field)
  expect(field.value).toBe('候选')
  await act(async () => {
    setDom('新的候选'); field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(writes).toHaveBeenLastCalledWith('新的候选')
  await act(async () => {
    setDom('最终问题'); field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  })
  expect(writes).toHaveBeenLastCalledWith('最终问题')
  expect(field.value).toBe('最终问题')
})

it('forwards caller error, read-only and disabled facts without adding a business state', async () => {
  const ref = createRef<HTMLTextAreaElement>(), write = vi.fn()
  await act(async () => root.render(<ComposerTextarea ref={ref} value="Retained draft" onValueChange={write}
    readOnly aria-invalid="true" aria-describedby="failure" />))
  expect(ref.current?.readOnly).toBe(true)
  expect(ref.current?.getAttribute('aria-describedby')).toBe('failure')
  expect(ref.current?.getAttribute('aria-invalid')).toBe('true')
  await act(async () => root.render(<ComposerTextarea ref={ref} value="Retained draft" onValueChange={write} disabled />))
  expect(ref.current?.disabled).toBe(true)
  expect(ref.current?.value).toBe('Retained draft')
  expect(write).not.toHaveBeenCalled()
})
