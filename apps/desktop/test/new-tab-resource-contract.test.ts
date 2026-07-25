import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_ACTIONS,
  DESKTOP_ACTION_ATTRIBUTE,
  DESKTOP_SESSION_ATTRIBUTE
} from '../src/shared/desktop-actions.js'

const fixture = vi.hoisted(() => {
  const session = {
    id: 'warm-run',
    kind: 'terminal',
    providerId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Terminal',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: {
      kind: 'terminal',
      hostId: 'local',
      runId: 'warm-run',
      run: { runId: 'warm-run' }
    }
  }
  const ready = Promise.resolve(session)
  return {
    session,
    ready,
    state: {
      config: {
        version: 7,
        hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
        executors: {},
        workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
        appearance: { terminalTheme: 'graphite' },
        browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
      },
      activeWorkspaceId: 'workspace',
      tabs: {},
      hostChecks: {},
      executorDetections: {},
      detectExecutors: vi.fn(async () => {}),
      launchAgent: vi.fn(async () => {}),
      promoteWarmTerminal: vi.fn(async () => {}),
      prewarmTerminal: vi.fn(),
      warmTerminal: { key: 'local\0/repo', ready, session },
      createBrowser: vi.fn(async () => {})
    }
  }
})

vi.mock('../src/renderer/src/store.js', () => ({
  executorDetectionKey: (hostId: string, executorId: string) => `${hostId}\0${executorId}`,
  warmTerminalKey: (hostId: string, workspacePath: string) => `${hostId}\0${workspacePath}`,
  useAppStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state)
}))

vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))

import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface.js'

afterEach(() => {
  fixture.state.warmTerminal = {
    key: 'local\0/repo',
    ready: fixture.ready,
    session: fixture.session
  }
})

describe('New Tab resource action contract', () => {
  it('exposes the ready reusable Terminal identity and Browser action without label guessing', () => {
    const markup = renderToStaticMarkup(createElement(NewTabSurface, { tabGroupId: 'group' }))

    expect(markup).toContain(`${DESKTOP_ACTION_ATTRIBUTE}="${DESKTOP_ACTIONS.claimReusableTerminal}"`)
    expect(markup).toContain(`${DESKTOP_SESSION_ATTRIBUTE}="${fixture.session.id}"`)
    expect(markup).toContain('aria-label="Open reusable Terminal in tab"')
    expect(markup).toContain(`${DESKTOP_ACTION_ATTRIBUTE}="${DESKTOP_ACTIONS.openBrowser}"`)
    expect(markup).toContain('aria-label="Open Browser"')
  })

  it('does not advertise a ready Session identity while the reusable Terminal is pending', () => {
    fixture.state.warmTerminal = {
      key: 'local\0/repo',
      ready: fixture.ready,
      session: null
    }

    const markup = renderToStaticMarkup(createElement(NewTabSurface, { tabGroupId: 'group' }))

    expect(markup).toContain(`${DESKTOP_ACTION_ATTRIBUTE}="${DESKTOP_ACTIONS.claimReusableTerminal}"`)
    expect(markup).not.toContain(DESKTOP_SESSION_ATTRIBUTE)
    expect(markup).toContain('aria-label="Open Terminal"')
  })
})
