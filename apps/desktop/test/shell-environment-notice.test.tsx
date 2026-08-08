// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { ShellEnvironmentNotice } from '../src/renderer/src/components/ShellEnvironmentNotice.js'
import { loginShellEnvironmentWarning } from '../src/main/login-shell-environment.js'

const initial = useAppStore.getState()
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true) })

describe('shell environment startup notice', () => {
  it('projects the snapshot notice into a persistent service window across navigation', async () => {
    const config = await api.config.get()
    const environmentWarning = loginShellEnvironmentWarning({ ok: true, shell: '/bin/zsh', mode: 'login' })!
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [], environmentWarning })
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    let dispose: (() => void) | undefined
    try {
      await act(async () => {
        dispose = await useAppStore.getState().initialize()
        root.render(<ShellEnvironmentNotice />)
      })
      expect(useAppStore.getState().loading).toBe(false)
      expect(element.querySelector('[role="status"]')?.textContent).toContain(environmentWarning)
      expect(element.textContent).toContain('restart AgentMux')
      await act(async () => useAppStore.getState().selectWorkspace(config.workspaces[0]!.id))
      expect(element.querySelector('[role="status"]')?.textContent).toContain(environmentWarning)
      expect(element.querySelector('button')).toBeNull()
      await act(async () => useAppStore.setState({ environmentWarning: null }))
      expect(element.textContent).toBe('')
    } finally {
      await act(async () => { dispose?.(); root.unmount() })
      element.remove()
    }
  })
})
