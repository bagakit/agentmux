import { describe, expect, it } from 'vitest'
import type { ExecutionHost } from '../src/execution-host.js'
import type { CommandResult } from '../src/process-runner.js'
import { TmuxClient } from '../src/tmux-client.js'

function hostWithListResult(result: CommandResult): ExecutionHost {
  return {
    id: 'fixture',
    kind: 'local',
    label: 'Fixture host',
    async run() {
      return result
    },
    async exposeLoopbackPort(port) {
      return port
    },
    async dispose() {}
  }
}

describe('TmuxClient list baseline', () => {
  it.each([
    'no server running on /tmp/tmux/default',
    'failed to connect to server',
    'error connecting to /private/tmp/tmux-501/default (No such file or directory)'
  ])('treats a missing tmux server as an empty list: %s', async (stderr) => {
    const client = new TmuxClient(hostWithListResult({ stdout: '', stderr, exitCode: 1 }))
    await expect(client.list()).resolves.toEqual([])
  })

  it('keeps unrelated tmux list failures visible', async () => {
    const client = new TmuxClient(hostWithListResult({ stdout: '', stderr: 'permission denied', exitCode: 1 }))
    await expect(client.list()).rejects.toMatchObject({ code: 'COMMAND_FAILED' })
  })
})
