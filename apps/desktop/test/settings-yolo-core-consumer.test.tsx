// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM()
it('consumes the public Core posture through the actual Settings module and complete configuration owner', async () => {
  const f = await configOwnerFixture({ executors: {
    primary: { label: 'Primary', providerId: 'codex', command: 'codex', args: ['--model','literal model','--sandbox','read-only'], env: { LITERAL: '$HOME' }, injectAgentMuxGuide: true },
    neighbor: { label: 'Neighbor', providerId: 'claude', command: 'claude', args: ['--model','opus'], env: {}, injectAgentMuxGuide: true }
  } })
  const baseline = f.owner.current.executors
  useAppStore.setState({ config: f.owner.current, providerCatalog: await api.providers.list(), executorDetections: {}, detectExecutors: vi.fn(async () => {}) })
  vi.spyOn(api.config,'save').mockImplementation(async (next,expected) => await f.owner.edit(expected!,next))
  await dom.render(<SettingsPanel initialSection="agents" executorId="primary" onClose={() => {}} />)
  await act(async () => {const details=dom.container.querySelector<HTMLDetailsElement>('.settings-launch-config')!;details.open=true;details.dispatchEvent(new Event('toggle'))})
  await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('.settings-launch-config button')].find(node=>node.textContent?.trim()==='Enable YOLO')!.click())
  await act(async () => { await vi.mocked(api.config.save).mock.results[0]!.value })
  const saved = (await f.disk()).executors
  expect(saved.primary!.args).toEqual(['--model','literal model','--sandbox','danger-full-access','--ask-for-approval','never'])
  expect(saved.primary!.env).toEqual({ LITERAL:'$HOME' })
  expect(saved.neighbor!.args).toEqual(['--model','opus'])
  expect(vi.mocked(api.config.save).mock.calls[0]![1]!.executors).toEqual(baseline)
})
