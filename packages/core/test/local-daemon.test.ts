import { describe, expect, it } from 'vitest'
import { activateAgentMuxLocalDaemon } from '../src/local-daemon.js'
import type { ProcessRunner } from '../src/process-runner.js'

describe('local daemon activation boundary', () => {
  it('executes the packaged agentmuxd entry and verifies the returned identity', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args })
      return {
        stdout: `${JSON.stringify({
          type: 'active',
          protocolVersion: 4,
          buildIdentity: 'build-1',
          hostId: 'local-test',
          daemonPid: 42,
          daemonInstanceId: 'daemon-1'
        })}\n`,
        stderr: '',
        exitCode: 0
      }
    }

    await expect(activateAgentMuxLocalDaemon({
      socketPath: '/tmp/agentmux-test.sock',
      statePath: '/tmp/agentmux-test.state.json',
      hostId: 'local-test',
      buildIdentity: 'build-1',
      runner
    })).resolves.toMatchObject({ daemonPid: 42, daemonInstanceId: 'daemon-1' })
    expect(calls[0]?.command).toBe(process.execPath)
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      'activate',
      '--socket',
      '/tmp/agentmux-test.sock',
      '--build-id',
      'build-1'
    ]))
  })

  it('fails closed when activation reports another daemon identity', async () => {
    await expect(activateAgentMuxLocalDaemon({
      hostId: 'expected-host',
      buildIdentity: 'expected-build',
      runner: async () => ({
        stdout: JSON.stringify({
          protocolVersion: 4,
          buildIdentity: 'other-build',
          hostId: 'expected-host',
          daemonPid: 42,
          daemonInstanceId: 'daemon-1'
        }),
        stderr: '',
        exitCode: 0
      })
    })).rejects.toMatchObject({ code: 'DAEMON_IDENTITY_MISMATCH' })
  })
})
