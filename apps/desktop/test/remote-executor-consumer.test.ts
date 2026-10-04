import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it } from 'vitest'
import { executorsForHost } from '../src/renderer/src/lib/executors'
import { executorDetectionKey } from '../src/renderer/src/lib/executor-detection'
import type { AppConfig } from '../src/shared/contracts'
import type { HostExecutorInventoryState } from '../src/renderer/src/store'

const local = { id: 'local', kind: 'local' as const, label: 'This Mac' }
const remote = { id: 'remote', kind: 'ssh' as const, label: 'Remote', hostname: 'example.invalid' }
const config = { hosts: [local, remote], executors: { shared: { label: 'Local template', providerId: 'codex', command: _hygiene_fixturePath("local/bin/codex"),
  args: ['--local-only'], env: { SECRET: 'private-local-value' }, injectAgentMuxGuide: true } } } as unknown as AppConfig
function inventory(availability: 'unknown' | 'available' | 'missing' | 'check-failed' = 'available'): HostExecutorInventoryState {
  return { input: remote, state: 'ready', result: { routeHostId: remote.id, runtimeId: 'remote-runtime', executors: [{
    executorId: 'shared', label: 'Remote configured Agent', providerId: 'claude', command: _hygiene_fixturePath("remote/bin/claude"), configRevision: 'remote-revision', source: 'registered', availability,
    ...(availability === 'available' ? { executable: _hygiene_fixturePath("remote/bin/claude") } : {}), ...(availability === 'check-failed' ? { cause: { code: 'EIO', message: 'Probe failed' } } : {})
  }] } }
}
it('the same executor ID resolves from the exact Host and never borrows local paths, Provider or environment', () => {
  const choices = executorsForHost(config, 'remote', {}, inventory())
  expect(choices).toMatchObject([{ id: 'shared', label: 'Remote configured Agent', providerId: 'claude', command: _hygiene_fixturePath("remote/bin/claude"), executorRevision: 'remote-revision', detection: { state: 'ready' } }])
  expect(choices[0]).not.toHaveProperty('env'); expect(choices[0]).not.toHaveProperty('args')
  expect(JSON.stringify(choices)).not.toContain('private-local-value')
  expect(executorsForHost(config, 'local', { [executorDetectionKey('local', 'shared')]: {
    input: { executorId: 'shared', providerId: 'codex', command: _hygiene_fixturePath("local/bin/codex"), host: local }, state: 'ready'
  } }, inventory())).toMatchObject([{ label: 'Local template', command: _hygiene_fixturePath("local/bin/codex"), detection: { state: 'ready' } }])
})
it.each([['unknown', 'idle'], ['available', 'ready'], ['missing', 'missing'], ['check-failed', 'error']] as const)('retains %s as its distinct Host fact', (availability, state) => {
  expect(executorsForHost(config, 'remote', {}, inventory(availability))[0]?.detection?.state).toBe(state)
})
it('a failed refresh retains known choices with a visible error, while an unobserved or changed Host remains unknown', () => {
  const previous = inventory(), failed = { ...previous, state: 'error' as const, detail: 'SSH connection failed' }
  expect(executorsForHost(config, 'remote', {}, failed)).toMatchObject([{ command: _hygiene_fixturePath("remote/bin/claude"), detection: { state: 'error', detail: 'SSH connection failed' } }])
  expect(executorsForHost(config, 'remote', {}, undefined)).toEqual([])
  expect(executorsForHost(config, 'remote', {}, { ...previous, input: { ...remote, hostname: 'another.invalid' } })).toEqual([])
})
