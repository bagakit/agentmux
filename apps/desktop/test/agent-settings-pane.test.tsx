import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'
import {
  AgentSettingsPane,
  assertExecutorProviderIdentity
} from '../src/renderer/src/components/settings/AgentSettingsPane.js'

const settingsFixture = vi.hoisted(() => ({
  state: {
    activeWorkspaceId: null,
    providerCatalog: [
      { id: 'codex', label: 'Codex', executable: 'codex' },
      { id: 'claude', label: 'Claude', executable: 'claude' }
    ],
    executorDetections: {},
    detectExecutors: vi.fn(async () => {})
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  executorDetectionKey: (hostId: string, executorId: string) => `${hostId}\0${executorId}`,
  useAppStore: (selector: (state: typeof settingsFixture.state) => unknown) => selector(settingsFixture.state)
}))

const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    review: {
      label: 'Review Codex',
      providerId: 'codex',
      command: 'codex',
      args: ['--full-auto'],
      env: {},
      injectAgentMuxGuide: true
    }
  },
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

describe('AgentSettingsPane Executor identity', () => {
  it('renders an existing Executor Provider as immutable identity', () => {
    const markup = renderToStaticMarkup(createElement(AgentSettingsPane, {
      config,
      onSave: async () => {}
    }))

    expect(markup).toContain('<span>Provider</span><select disabled=""')
    expect(markup).toContain('Provider is part of this Executor identity. Create a new Executor to change it.')
    expect(markup).toContain('Add executor')
  })

  it('rejects Provider rebinding while allowing a new Executor to select its Provider', () => {
    expect(() => assertExecutorProviderIdentity(
      'review',
      config.executors.review,
      'claude'
    )).toThrow('Executor review already belongs to Codex')

    expect(() => assertExecutorProviderIdentity(
      'review',
      config.executors.review,
      'codex'
    )).not.toThrow()
    expect(() => assertExecutorProviderIdentity('new-review', undefined, 'claude')).not.toThrow()
  })
})
