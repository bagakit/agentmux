import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxControlServer, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller.js'
import type { AppConfig, HostConfig } from '../src/shared/contracts.js'
import { executorEnvironmentRevision } from '../src/shared/executor-probe-context.js'
import { executorDetectionMatches } from '../src/renderer/src/lib/executor-detection.js'

const execute = promisify(execFile), cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
it('public CLI checks the saved private PATH and invalidates stale checks without returning that environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'exctrl-'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'r')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 's'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const executable = join(root, 'context-command')
  await writeFile(executable, '#!/bin/sh\n'); await chmod(executable, 0o755)
  const host: HostConfig = { id: 'local', kind: 'local', label: 'Original Host' }
  const config = { hosts: [host], executors: { original: { label: 'Original Executor', providerId: 'claude',
    command: 'context-command', args: [], env: { PATH: root, PRIVATE_VALUE: 'private-value' }, injectAgentMuxGuide: false } } } as unknown as AppConfig
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  const connected = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Executable observation must not connect Native'))
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => { throw new Error('No connector is used by this observation') })
  // Only connection inventory is a fixture seam. CLI, service, Main detection,
  // exact context construction and Core filesystem observation are production owners.
  Reflect.get(runtime, 'hosts').set(host.id, { client, config: host })
  const { label: _label, ...identity } = host
  Reflect.get(runtime, 'hostSignatures').set(host.id, JSON.stringify(identity))
  const server = new AgentMuxControlServer({ execute: async request => {
    if (request.operation !== 'settings.executors.refresh') throw new Error('Only the original executable check is authorized')
    return { operation: request.operation, ...await runtime.detect(request.executorId, request.hostId, config) }
  } }, join(root, 'p.sock'))
  cleanups.push(async () => { await server.stop(); await client.dispose(); await rm(root, { recursive: true, force: true }) })
  await server.start()
  const result = await execute(process.execPath, [resolve('packages/core/bin/amux'), '--endpoint', 'unix:' + server.path,
    'settings', 'executors', 'refresh', 'original', '--host', host.id], { timeout: 10_000,
    env: { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } })
  const value = JSON.parse(result.stdout).result
  expect(value).toMatchObject({ availability: 'available', input: { executorId: 'original', command: 'context-command',
    environmentRevision: executorEnvironmentRevision(config.executors.original!.env) } })
  expect(JSON.stringify(value)).not.toContain('private-value'); expect(JSON.stringify(value)).not.toContain(root)
  expect(executorDetectionMatches(value.input, 'original', config.executors.original, host)).toBe(true)
  expect(executorDetectionMatches(value.input, 'original', { ...config.executors.original!, env: { PATH: root + '-changed' } }, host)).toBe(false)
  expect(executorDetectionMatches(value.input, 'original', { ...config.executors.original!, env: { ...config.executors.original!.env, PRIVATE_VALUE: 'changed' } }, host)).toBe(true)
  expect(connected).not.toHaveBeenCalled()
})
