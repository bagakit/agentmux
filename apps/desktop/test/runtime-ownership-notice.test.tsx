// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { RuntimeOwnershipNotice } from '../src/renderer/src/components/RuntimeOwnershipNotice.js'

const initial = useAppStore.getState()
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true) })

describe('Runtime launch provenance notice', () => {
  it('projects the snapshot notice into a persistent service window across navigation', async () => {
    const config = await api.config.get()
    const runtimeOwnershipWarnings = ['local']
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [], runtimeOwnershipWarnings })
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    let dispose: (() => void) | undefined
    try {
      await act(async () => {
        dispose = await useAppStore.getState().initialize()
        root.render(<RuntimeOwnershipNotice />)
      })
      expect(useAppStore.getState().loading).toBe(false)
      expect(element.querySelector('[role="status"]')?.textContent).toContain('Existing Agents remain usable')
      expect(element.textContent).toContain('restarting the app is not required')
      await act(async () => useAppStore.getState().selectWorkspace(config.workspaces[0]!.id))
      expect(element.querySelector('[role="status"]')?.textContent).toContain('Existing Agents remain usable')
      expect(element.querySelector('button')).toBeNull()
      await act(async () => useAppStore.setState({ runtimeOwnershipWarnings: [] }))
      expect(element.textContent).toBe('')
    } finally {
      await act(async () => { dispose?.(); root.unmount() })
      element.remove()
    }
  })
})
