import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { AgentMuxControlServer } from '../src/control-host.js'
import type { AgentMuxControlRequest } from '../src/control.js'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))

it('real CLI send retains managed authors for every target without inventing an author for human CLI use', async () => {
  const runtime = await mkdtemp('/tmp/amux-mail-cli-')
  const requests: AgentMuxControlRequest[] = []
  const server = new AgentMuxControlServer({ execute: async (request) => {
    requests.push(request)
    return { operation: 'send', agentSessionId: 'recipient' }
  } }, join(runtime, 'control.sock'))
  await server.start()
  try {
    for (const [flag, id] of [['--to-session', 'other'], ['--to-region', 'region'], ['--to-tab', 'tab'], ['--to-session', 'self']]) {
      await exec(cli, ['send', flag!, id!, '--text', 'actual mail'], { timeout: 5000, env: {
        ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: 'sender'
      } })
    }
    expect(requests.map((request) => request.operation === 'send' && [request.target, request.caller, request.text])).toEqual([
      [{ kind: 'agent-session', agentSessionId: 'other' }, { agentSessionId: 'sender' }, 'actual mail'],
      [{ kind: 'region', regionId: 'region' }, { agentSessionId: 'sender' }, 'actual mail'],
      [{ kind: 'tab', tabId: 'tab' }, { agentSessionId: 'sender' }, 'actual mail'],
      [{ kind: 'self' }, { agentSessionId: 'sender' }, 'actual mail']
    ])
    const humanEnv = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: 'not-managed' }
    await exec(cli, ['send', '--to-session', 'other', '--text', 'human mail'], { timeout: 5000, env: humanEnv })
    expect(requests.at(-1)).toMatchObject({ operation: 'send', text: 'human mail' })
    expect(requests.at(-1)).not.toHaveProperty('caller')
    await expect(exec(cli, ['send', '--to-session', 'self', '--text', 'not allowed'], { timeout: 5000, env: humanEnv }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('MANAGED_AGENT_CONTEXT_REQUIRED') })
    expect(requests).toHaveLength(5)
  } finally {
    await server.stop()
    await rm(runtime, { recursive: true, force: true })
  }
})
