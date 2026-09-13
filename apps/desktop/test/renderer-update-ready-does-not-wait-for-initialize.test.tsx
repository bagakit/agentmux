// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
import { App } from '../src/renderer/src/App.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initial = useAppStore.getState()
const appSourcePath = join(import.meta.dirname, '../src/renderer/src/App.tsx')
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

let mounted: { root: Root; element: HTMLElement } | null = null
afterEach(async () => {
  if (mounted) {
    const { root, element } = mounted
    mounted = null
    await act(async () => { root.unmount() })
    element.remove()
  }
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
  window.history.replaceState({}, '', '/')
})

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('renderer-update ready handshake', () => {
  it('reports ready while Session recovery is still running', async () => {
    const ready = vi.spyOn(api.ui, 'rendererUpdateReady').mockResolvedValue(undefined)
    useAppStore.setState({
      initialize: () => new Promise(() => {})
    })
    window.history.replaceState({}, '', '/index.html?renderer-update=token-cold-start')
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    mounted = { root, element }
    await act(async () => { root.render(<App />) })
    expect(ready.mock.calls).toEqual([['token-cold-start']])
  })

  it('does not put the ready report inside initialize().then', () => {
    const source = stripComments(readFileSync(appSourcePath, 'utf8'))
    const start = source.indexOf('void initialize().then')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('}, [initialize]', start)
    expect(end).toBeGreaterThan(start)
    const recoveryEffect = source.slice(start, end)
    expect(recoveryEffect.length).toBeGreaterThan(0)
    expect(recoveryEffect).toContain('initialize()')
    expect(recoveryEffect).not.toContain('rendererUpdateReady')
    expect(source).toContain('api.ui.rendererUpdateReady')
  })
})
