// @vitest-environment happy-dom
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('monaco-editor', () => ({}))
import { useAppStore } from '../src/renderer/src/store'
import { useWorkspaceResourceKey, workspaceResourceKey } from '../src/renderer/src/lib/workspace-resource-key'
import { composerConfig } from './helpers/composer-dom-fixture'

type Config = NonNullable<ReturnType<typeof useAppStore.getState>['config']>
const moved = (config: Config, change: Partial<Config['workspaces'][number]>): Config =>
  ({ ...config, workspaces: config.workspaces.map(item => item.id === 'workspace' ? { ...item, ...change } : item) })

describe('Workspace resource key', () => {
  it('changes when the Workspace moves to another root or Host, and only then', () => {
    const base = composerConfig as Config, key = workspaceResourceKey('workspace', base)
    expect(workspaceResourceKey('workspace', moved(base, { path: '/elsewhere' }))).not.toBe(key)
    expect(workspaceResourceKey('workspace', moved(base, { hostId: 'other-host' }))).not.toBe(key)
    expect(workspaceResourceKey('workspace', moved(base, { name: 'Renamed label' }))).toBe(key)
    expect(workspaceResourceKey('missing', base)).not.toBe(key)
  })

  describe('as a store selector', () => {
    let root: Root, container: HTMLDivElement
    beforeEach(() => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
      useAppStore.setState({ config: composerConfig })
      container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    })
    afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

    it('reads the Workspaces only when config changes', async () => {
      const seen: string[] = []
      function Probe() { seen.push(useWorkspaceResourceKey('workspace')); return null }
      await act(async () => root.render(<Probe />))
      const workspaces = useAppStore.getState().config!.workspaces, find = vi.spyOn(workspaces, 'find')
      await act(async () => { for (let index = 0; index < 10; index++) useAppStore.setState({ lastError: `unrelated ${index}` }) })
      expect(find).not.toHaveBeenCalled()
      await act(async () => { useAppStore.setState({ config: moved(useAppStore.getState().config as Config, { path: '/elsewhere' }) }) })
      expect(new Set(seen).size).toBe(2)
    })
  })
})
