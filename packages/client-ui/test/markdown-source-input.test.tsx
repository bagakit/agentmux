import { act, createRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerTextarea } from '../src/input/ComposerTextarea.js'
import { Textarea } from '../src/input/Textarea.js'

const mounted: Array<() => void> = []

function mount(element: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push(() => { act(() => root.unmount()); container.remove() })
  return { container, render: (next = element) => act(async () => root.render(next)) }
}

const setNativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
function type(input: HTMLTextAreaElement, value: string) {
  setNativeValue.call(input, value)
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }))
}

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => {
  mounted.splice(0).forEach(remove => remove())
  vi.unstubAllGlobals()
})

describe('native Markdown source input', () => {
  it('decorates exact source through the original native field, including after form reset', async () => {
    const original = '# 中文 😀\n\n- **read** `here`\n'
    const input = createRef<HTMLTextAreaElement>()
    const { container, render } = mount(<form>
      <label htmlFor="subject">Message</label><Textarea id="subject" name="subject" ref={input} syntax="markdown" defaultValue={original} />
    </form>)
    await render()
    const textarea = container.querySelector('textarea')!
    const preview = container.querySelector('[data-ui-markdown-preview]')!
    await vi.waitFor(() => expect(preview.querySelector('[data-markdown-token="heading"]')?.textContent).toBe('# 中文 😀'))
    expect(input.current).toBe(textarea)
    expect(preview.getAttribute('aria-hidden')).toBe('true')
    expect(preview.textContent).toBe(original)
    expect(preview.querySelector('[data-markdown-token="emphasis"]')?.textContent).toBe('**read**')
    textarea.focus()
    textarea.setSelectionRange(2, 7, 'backward')
    expect(new FormData(container.querySelector('form')!).get('subject')).toBe(original)
    expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([2, 7, 'backward'])
    await act(async () => type(textarea, '> quoted\n'))
    await vi.waitFor(() => expect(preview.textContent).toBe('> quoted\n'))
    await act(async () => container.querySelector('form')!.reset())
    await vi.waitFor(() => expect(preview.textContent).toBe(original))
    expect(input.current).toBe(textarea)
    expect(textarea.value).toBe(original)
  })

  it('inherits the same decoration in a controlled composer and leaves ordinary input native', async () => {
    const ref = createRef<HTMLTextAreaElement>()
    function Form() {
      const [text, setText] = useState('**strong**')
      return <>
        <ComposerTextarea ref={ref} syntax="markdown" value={text} onValueChange={setText} />
        <Textarea data-plain defaultValue="**literal**" />
        <button type="button" onClick={() => setText('`code`')}>Replace</button>
      </>
    }
    const { container, render } = mount(<Form />)
    await render()
    const original = ref.current
    expect(original).toBeInstanceOf(HTMLTextAreaElement)
    await vi.waitFor(() => expect(container.querySelector('[data-markdown-token="emphasis"]')?.textContent).toBe('**strong**'))
    expect(container.querySelector('[data-plain]')?.parentElement).toBe(container)
    expect(container.querySelectorAll('[data-ui-markdown-preview]')).toHaveLength(1)
    await act(async () => container.querySelector('button')!.click())
    await vi.waitFor(() => expect(container.querySelector('[data-markdown-token="code"]')?.textContent).toBe('`code`'))
    expect(ref.current).toBe(original)
    expect(ref.current?.value).toBe('`code`')
    expect(container.querySelector<HTMLTextAreaElement>('[data-plain]')?.value).toBe('**literal**')
  })
})
