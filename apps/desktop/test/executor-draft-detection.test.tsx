// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '@agentmux/core'
import { AgentSettingsPane } from '../src/renderer/src/components/settings/AgentSettingsPane'
import { executorEnvironmentRevision } from '../src/shared/executor-probe-context'
import { executorDetectionKey, useAppStore, type ExecutorDetectionState } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), onSave = vi.fn(async () => {}), key = executorDetectionKey('local', 'codex')
const config = (env: Record<string, string>) => ({ ...composerConfig, executors: {
  codex: { ...composerConfig.executors.codex!, env }
} })
function detection(env: Record<string, string>): ExecutorDetectionState {
  const input = { executorId: 'codex', providerId: 'codex', command: 'codex', host: composerConfig.hosts[0]!,
    environmentRevision: executorEnvironmentRevision(env) }
  return { state: 'ready', input, result: { input, executable: 'codex', availability: 'available' } }
}
const status = () => dom.container.querySelector('#executor-settings-codex .check-pill')?.textContent
const editor = () => dom.container.querySelector<HTMLTextAreaElement>('.settings-launch-config textarea')!
async function edit(value: string) {
  const node = editor()
  expect(node?.isConnected).toBe(true)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(editor()).toBe(node); expect(node.value).toBe(value)
}
beforeEach(() => {
  onSave.mockClear()
  useAppStore.setState({ providerCatalog: new AgentProviderRegistry().catalog(),
    detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}) })
})

it('the actual editor matches the parsed PATH draft, preserves equivalent JSON and invalidates changed values only', async () => {
  const env = { PATH: 'search-one:search-two', LITERAL: 'unchanged' }, saved = config(env), original = detection(env)
  useAppStore.setState({ config: saved, executorDetections: { [key]: original } })
  await dom.render(<AgentSettingsPane config={saved} onSave={onSave} />)
  expect(status()).toBe('Available')
  const checks = vi.mocked(useAppStore.getState().detectExecutors).mock.calls.length
  await edit('{ "LITERAL": "unchanged", "PATH": "search-one:search-two" }')
  expect(status()).toBe('Available')
  await edit('{"PATH":"search-one:search-two","LITERAL":"edited non-probe value"}')
  expect(status()).toBe('Available')
  await edit('{"PATH":"different-search"}')
  expect(status()).toBe('Not checked')
  await edit(JSON.stringify(env))
  expect(status()).toBe('Available')
  await act(async () => {
    useAppStore.setState({ executorDetections: { [key]: { ...original, state: 'error', detail: 'Original observation failed' } } })
  })
  expect(status()).toBe('Check failed')
  expect(dom.container.textContent).toContain('Original observation failed')
  await edit('{"PATH":"changed-again"}')
  expect(status()).toBe('Not checked')
  expect(dom.container.textContent).not.toContain('Original observation failed')
  expect(useAppStore.getState().config).toEqual(saved)
  expect(useAppStore.getState().executorDetections[key]?.input).toEqual(original.input)
  expect(vi.mocked(useAppStore.getState().detectExecutors).mock.calls).toHaveLength(checks)
  expect(onSave).not.toHaveBeenCalled()
})

it('invalid environment drafts remain editable and unknown without guessing the saved empty environment', async () => {
  const saved = config({}), original = detection({})
  useAppStore.setState({ config: saved, executorDetections: { [key]: original } })
  await dom.render(<AgentSettingsPane config={saved} onSave={onSave} />)
  expect(status()).toBe('Available')
  for (const invalid of ['{', 'null', '[]', '{"PATH":5}', '{"LITERAL":false}']) {
    await edit(invalid)
    expect(status()).toBe('Not checked')
    expect(useAppStore.getState().executorDetections[key]).toEqual(original)
    expect(useAppStore.getState().config).toEqual(saved)
    expect(onSave).not.toHaveBeenCalled()
  }
  await edit(' { } ')
  expect(status()).toBe('Available')
})
