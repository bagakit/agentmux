import { describe, expect, it, vi } from 'vitest'
import { defaultAgentMuxMessageQueuePath, defaultAgentMuxStateDirectory } from '@agentmux/core'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { macosHostService, macosHostServiceAddress, macosHostServicePlist, normalizeMacosHostServiceDefinition, parseMacosServiceList } from '../src/macos-service.js'

const input = { executable: process.execPath, entrypoint: fixturePath('host/entry.js'),
  storePath: fixturePath('host/state/sessions.json'), socketPath: fixturePath('host/runtime/control.sock'),
  mobileBuildDirectory: fixturePath('host/mobile'), environment: {} }

describe('the macOS Host has one platform service per original endpoint', () => {
  it('recognizes explicit default paths without borrowing the cold launcher environment', () => {
    const original = { Label: 'original', ProgramArguments: ['program', '--store', input.storePath],
      KeepAlive: true, EnvironmentVariables: { ELECTRON_RUN_AS_NODE: '1' } }
    const explicit = { ...original, EnvironmentVariables: { ...original.EnvironmentVariables,
      AGENTMUX_STATE_DIRECTORY: defaultAgentMuxStateDirectory({}),
      AGENTMUX_MESSAGE_QUEUE_PATH: defaultAgentMuxMessageQueuePath(input.storePath, '') } }
    vi.stubEnv('AGENTMUX_STATE_DIRECTORY', fixturePath('unrelated/state'))
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', fixturePath('unrelated/queue.ndjson'))
    try {
      expect(normalizeMacosHostServiceDefinition(original, input.storePath))
        .toEqual(normalizeMacosHostServiceDefinition(explicit, input.storePath))
      for (const [key, value] of Object.entries({ AGENTMUX_STATE_DIRECTORY: fixturePath('another/state'),
        AGENTMUX_MESSAGE_QUEUE_PATH: fixturePath('another/queue.ndjson'), UNRECOGNIZED: 'extra' })) {
        expect(normalizeMacosHostServiceDefinition({ ...explicit,
          EnvironmentVariables: { ...explicit.EnvironmentVariables, [key]: value } }, input.storePath))
          .not.toEqual(normalizeMacosHostServiceDefinition(original, input.storePath))
      }
      for (const changed of [{ ...original, UnknownKey: true }, { ...original, KeepAlive: false },
        { ...original, ProgramArguments: [...original.ProgramArguments].reverse() },
        { ...original, EnvironmentVariables: { ELECTRON_RUN_AS_NODE: 1 } }]) {
        expect(normalizeMacosHostServiceDefinition(changed, input.storePath))
          .not.toEqual(normalizeMacosHostServiceDefinition(original, input.storePath))
      }
    } finally { vi.unstubAllEnvs() }
  })

  it('preserves namespace overrides and persists only the service environment', () => {
    const service = macosHostService({ ...input, environment: { AGENTMUX_RUNTIME_DIRECTORY: fixturePath('original/runtime'),
      AGENTMUX_STATE_DIRECTORY: fixturePath('original/state'), AGENTMUX_MESSAGE_QUEUE_PATH: fixturePath('original/messages.ndjson'),
      AGENTMUX_SPATIAL_STATE_STORE: fixturePath('original/spatial.json'), AGENTMUX_AGENT_SESSION_ID: 'caller-session',
      AGENTMUX_AGENT_CAPABILITY: 'private-authority', USER_SECRET: 'private-value', PATH: 'caller-search-path' } })
    expect(service.environment).toEqual({ ELECTRON_RUN_AS_NODE: '1', AGENTMUX_AGENT_SESSION_STORE: input.storePath,
      AGENTMUX_MOBILE_BUILD_DIRECTORY: input.mobileBuildDirectory,
      AGENTMUX_RUNTIME_DIRECTORY: fixturePath('original/runtime'), AGENTMUX_STATE_DIRECTORY: fixturePath('original/state'),
      AGENTMUX_MESSAGE_QUEUE_PATH: fixturePath('original/messages.ndjson'), AGENTMUX_SPATIAL_STATE_STORE: fixturePath('original/spatial.json') })
    expect(service.target).toBe(macosHostServiceAddress(input.socketPath).target)
    expect(macosHostService({ ...input, executable: fixturePath('candidate/Node') }).label).toBe(service.label)
    expect(macosHostService({ ...input, socketPath: fixturePath('another/runtime/control.sock') }).label).not.toBe(service.label)
  })

  it('describes the existing foreground entry and lets launchd own restart', () => {
    const service = macosHostService({ ...input, configuration: { path: fixturePath('config/original.json'),
      connectorDirectory: fixturePath('config/connectors') }, workspaceMoveHelper: fixturePath('bin/workspace-move') })
    const plist = macosHostServicePlist(service)
    expect(plist).toContain('<key>KeepAlive</key><true/>')
    expect(plist).toContain('<key>ProgramArguments</key><array>')
    expect(plist).toContain('<string>--store</string>')
    expect(plist).toContain(input.entrypoint)
    expect(plist).not.toContain('RunAtLoad')
    expect(plist).not.toContain('WatchPaths')
    expect(service.plistPath).not.toContain('LaunchAgents')
    expect(service.environment.AGENTMUX_HOST_CONFIGURATION_PATH).toBe(service.environment.AGENTMUX_MOTE_CONFIGURATION_PATH)
  })

  it('escapes property-list values and refuses a relative namespace', () => {
    const plist = macosHostServicePlist(macosHostService({ ...input, mobileBuildDirectory: fixturePath('mobile/&<>') }))
    expect(plist).toContain('&amp;&lt;&gt;')
    expect(() => macosHostService({ ...input, storePath: 'sessions.json' })).toThrow('absolute')
  })

  it('uses documented list columns, including an unloaded process within a registered job', () => {
    expect(parseMacosServiceList('PID\tStatus\tLabel\n123\t0\tservice.running\n-\t-9\tservice.waiting\n-\t0\tunrelated service with spaces\n'))
      .toEqual([{ label: 'service.running', pid: 123 }, { label: 'service.waiting', pid: null }, { label: 'unrelated service with spaces', pid: null }])
    for (const value of ['', 'PID\tStatus\tLabel', 'not a directory\n123 0 service',
      'PID Status Label\nnot-a-pid 0 service', 'PID Status Label\n0 0 service']) {
      expect(() => parseMacosServiceList(value)).toThrow()
    }
  })
})
