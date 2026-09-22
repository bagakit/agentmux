import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const workbench = read('../src/renderer/src/components/WorkspaceWorkbench.tsx')
const app = read('../src/renderer/src/App.tsx')
const hook = read('../src/renderer/src/hooks/useNativeOverlayChrome.ts')
const pane = read('../src/renderer/src/components/BrowserPane.tsx')

describe('native Browser remains visible while Chrome floats', () => {
  it('both real workbench projections retain native pages independently of floating panels', () => {
    const file = ts.createSourceFile('workbench.tsx', workbench, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const expressions: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText(file) === 'nativeSurfacesVisible') expressions.push(node.initializer?.getText(file) ?? '')
      ts.forEachChild(node, visit)
    }
    const owner = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'WorkspaceWorkbench')
    expect(owner).toBeDefined()
    visit(owner!)
    expect(expressions).toEqual(['{visible && !focusTab && activeDrag === null}', '{tabVisible && activeDrag === null}'])
  })
  it('the one App consumer publishes Chrome regions through the real privileged API', () => {
    expect(app.split('useNativeOverlayChrome()')).toHaveLength(2)
    expect(app).toContain("from './hooks/useNativeOverlayChrome'")
    expect(hook).toContain('observeNativeOverlayRegions(document.body, api.ui.getZoomFactor')
    expect(hook).toContain('api.ui.publishNativeOverlays(next.regions)')
    expect(app).toContain('nativeOverlayWarning={nativeOverlayWarning}')
  })
  it('a local menu cannot tear down the original bounds synchronizer or hide its Browser', () => {
    const start = pane.indexOf('const synchronizer = new LatestBrowserBoundsSynchronizer(')
    expect(start).toBeGreaterThan(-1)
    const end = pane.indexOf('// 焦点环内缩是一件', start)
    expect(end).toBeGreaterThan(start)
    const boundsEffect = pane.slice(start, end)
    expect(boundsEffect).toContain('synchronizer.observe(rendererCssBoundsToWindowDip')
    expect(boundsEffect).not.toContain('menuOpen')
    expect(boundsEffect).not.toContain('screenshot')
  })
})
