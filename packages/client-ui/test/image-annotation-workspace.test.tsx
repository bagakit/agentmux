// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  commitShape, createScreenshotDocument, imageAnnotationHistoryCommand, marqueeSelection, redoShape, undoShape
} from '@agentmux/client-ui/image-annotation'

function AnnotationSurface() {
  const [drawing, edit] = useState(createScreenshotDocument)
  const selected = marqueeSelection(drawing.shapes, { x: 0, y: 0, width: 40, height: 40 })
  return <div onKeyDown={event => {
    const command = imageAnnotationHistoryCommand(event)
    if (command) edit(command === 'undo' ? undoShape : redoShape)
  }}>
    <button onClick={() => edit(current => commitShape(current, {
      id: 'original-mark', kind: 'rect', color: '#111', width: 2,
      from: { x: 10, y: 10 }, to: { x: 30, y: 30 }
    }))}>Draw</button>
    <output>{Array.from(selected).join(',')}</output>
  </div>
}

it('mounts the shared selection and history in a React document without Desktop', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<AnnotationSurface />))
    const draw = container.querySelector('button')!
    const selected = container.querySelector('output')!
    await act(async () => draw.click())
    expect(selected.textContent).toBe('original-mark')
    const historyKey = (shiftKey: boolean) => draw.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey, bubbles: true }))
    await act(async () => { historyKey(false) })
    expect(selected.textContent).toBe('')
    await act(async () => { historyKey(true) })
    expect(selected.textContent).toBe('original-mark')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
