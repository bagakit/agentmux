import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect } from 'vitest'
import { AgentMuxControlServer, parseAgentMuxControlReceipt } from '../../src/control-host.js'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '../../src/control.js'

const exec = promisify(execFile)
/** Protocol fixture only. Desktop tests separately prove actual owner application. */
export function workfaceCliFixture(initial: AgentMuxControlResult) {
  let root: string, server: AgentMuxControlServer, env: NodeJS.ProcessEnv
  const seen: AgentMuxControlRequest[] = []
  let reply = initial
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'amx-workface-wire-'))
    env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })
    server = new AgentMuxControlServer({ async execute(request) { seen.push(request); return reply } }, join(root, 'control.sock'))
    await server.start()
  })
  afterAll(async () => { await server?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
  async function run(args: string[]) {
    try { return { code: 0, ...await exec(process.execPath, [join(process.cwd(), 'packages/core/bin/agentmux'), ...args], { env, timeout: 5_000 }) } }
    catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string }
      if (typeof failure.code !== 'number') throw error
      return failure
    }
  }
  async function receipt(args: string[], code = 0) {
    const actual = await run(args)
    expect(actual.code, actual.stderr).toBe(code)
    const lines = actual.stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = parseAgentMuxControlReceipt(JSON.parse(lines[0]!))
    expect(parsed.ok).toBe(true)
    return parsed
  }
  return { seen, run, receipt, setReply(value: AgentMuxControlResult) { reply = value } }
}
export const saved = { layoutApplied: true, localStorageWritten: true, storageFlushRequested: true,
  diskDurability: 'unconfirmed' as const, reason: null }
export const location = { spaceId: 'space-exact', zoneId: 'zone-exact', workspaceId: 'resource-exact',
  displayWorkspaceId: 'display-exact', groupId: 'group-exact', tabId: 'tab-exact', regionId: 'region-exact' }
