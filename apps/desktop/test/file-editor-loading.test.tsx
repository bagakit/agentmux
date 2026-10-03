// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { editorPaneStoreState } from './helpers/editor-pane-store'

const fixture = vi.hoisted(() => ({ state: {} as Record<string, any>, engineLoads: 0 }))
vi.mock('../src/renderer/src/monaco', () => { fixture.engineLoads++; return {} })
vi.mock('@monaco-editor/react', () => ({ default: () => <textarea aria-label="Source projection" /> }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign(
  (select: (state: typeof fixture.state) => unknown) => select(fixture.state),
  { getState: () => fixture.state }
) }))
import { EditorPane } from '../src/renderer/src/components/EditorPane'

it('renders the original preview and header before admitting the source engine', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.state = { ...editorPaneStoreState(),
    documents: { ['workspace\0drawing.svg']: { path: 'drawing.svg', content: '<svg/>', revision: 'r1' } },
    editorRegionModes: { region: 'preview' }
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const view = () => <EditorPane tabId="tab" surface={{ kind: 'file', workspaceId: 'workspace', path: 'drawing.svg', regionId: 'region' }}
    preview={<div>Original SVG preview</div>} onTogglePreview={() => {}} />
  try {
    expect(fixture.engineLoads).toBe(0)
    await act(async () => { root.render(view()); await vi.dynamicImportSettled() })
    expect(container.textContent).toContain('Original SVG preview')
    expect(container.querySelector('.editor-header')).not.toBeNull()
    expect(fixture.engineLoads).toBe(0)
    fixture.state.editorRegionModes.region = 'edit'
    await act(async () => { root.render(view()); await vi.dynamicImportSettled() })
    await act(async () => { await vi.dynamicImportSettled() })
    expect(fixture.engineLoads).toBe(1)
    expect(container.querySelector('textarea[aria-label="Source projection"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Original SVG preview')
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals()
  }
})
