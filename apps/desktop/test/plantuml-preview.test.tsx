// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { PlantUmlFilePreview } from '../src/renderer/src/components/file-preview/PlantUmlFilePreview'

const calls = vi.hoisted(() => ({ preview: vi.fn() }))
vi.mock('../src/renderer/src/components/file-preview/DiagramFilePreview', () => ({ DiagramFilePreview: (props: unknown) => { calls.preview(props); return null } }))

it('PlantUML uses the shared disposable host consumer with the unchanged current draft and visibility', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), root = createRoot(container)
  const content = '@startuml\nAlice -> Bob : unsaved\n@enduml'
  try {
    await act(async () => root.render(<PlantUmlFilePreview content={content} path="a.puml" visible />))
    expect(calls.preview.mock.calls.at(-1)?.[0]).toMatchObject({ content, kind: 'plantuml', path: 'a.puml', visible: true })
    calls.preview.mockClear()
    await act(async () => root.render(<PlantUmlFilePreview content={content} visible={false} />))
    expect(calls.preview).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})
