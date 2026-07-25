import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'
import {
  AgentSettingsPane,
  assertExecutorProviderIdentity,
  parseExecutorArgs
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

describe('parseExecutorArgs', () => {
  it('splits a shell-style launch line into argv, stripping quotes as syntax', () => {
    // The user's exact reported string. Before the fix it split on '\n' only, so the whole line became a
    // single argv token and the downstream CLI died with "unknown option '--dangerously-skip-permissions
    // --model 'default' --effort 'ultracode''". Each flag and value must be its own argv entry.
    expect(parseExecutorArgs("--dangerously-skip-permissions --model 'default' --effort 'ultracode'"))
      .toEqual(['--dangerously-skip-permissions', '--model', 'default', '--effort', 'ultracode'])
  })

  it('keeps a quoted value with a space as one argv entry', () => {
    expect(parseExecutorArgs('--model "gpt 5"')).toEqual(['--model', 'gpt 5'])
  })

  it('collapses runs of whitespace and treats newlines as separators', () => {
    expect(parseExecutorArgs('--model   fable')).toEqual(['--model', 'fable'])
    expect(parseExecutorArgs('--model\nfable\n--effort high'))
      .toEqual(['--model', 'fable', '--effort', 'high'])
  })

  it('returns an empty argv for empty or whitespace-only input', () => {
    expect(parseExecutorArgs('')).toEqual([])
    expect(parseExecutorArgs('   \n\t ')).toEqual([])
  })
})
