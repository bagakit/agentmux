import { fixturePath as upstreamFixturePath, fixtureDisplayPath as upstreamFixtureDisplayPath } from './helpers/fixture-values.js'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient as DefaultClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { composeAgentLaunchPrompt } from '../src/agent-outbound-message.js'
import { AGENTMUX_AGENT_MESSAGING_RULES, AGENTMUX_AGENT_MESSAGING_GUIDANCE } from '../src/agent-messaging-guidance.js'

const exec = promisify(execFile)
const AgentMuxClient: typeof DefaultClient = process.env.AGENTMUX_TEST_GUIDANCE_CLIENT
  ? (await import(process.env.AGENTMUX_TEST_GUIDANCE_CLIENT)).AgentMuxClient : DefaultClient
const cli = process.env.AGENTMUX_TEST_GUIDANCE_CLI ?? fileURLToPath(new URL('../dist/agentmux.js', import.meta.url))
const daemon = process.env.AGENTMUX_TEST_GUIDANCE_DAEMON ?? fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url))
it('real whoami, skill and actual creation guide discover one cross Session messaging contract', async () => {
  const root = await mkdtemp(upstreamFixtureDisplayPath("tmp/amux-messaging-guidance-")), storePath = join(root, 'sessions.json')
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: storePath, AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
  for (const name of ['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_AGENT_SESSION_STORE', 'AGENTMUX_MESSAGE_QUEUE_PATH']) vi.stubEnv(name, env[name as keyof typeof env])
  const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(storePath) })
  const owned = async () => (await exec('/bin/ps', ['-axo', 'pid=,command='])).stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
    return match && match[2]!.includes('/ctxmuxd ') &&
      match[2]!.includes('--socket ' + join(root, 'runtime', 'ctxmux.sock') + ' ') &&
      match[2]!.includes('--state-dir ' + join(root, 'state', 'ctxmux') + ' ')
      ? [{ pid: Number(match[1]), command: match[2]! }] : []
  })
  let created: Awaited<ReturnType<typeof client.createAgent>> | undefined
  let ownerPid: number | undefined
  try {
    await client.connect()
    const owners = await owned()
    expect(owners).toHaveLength(1)
    ownerPid = owners[0]!.pid
    expect(owners[0]!.command.startsWith(daemon + ' ')).toBe(true)
    created = await client.createAgent({ agentSessionId: 'private-discovery-agent', createOperationId: 'private-discovery-create',
      executorId: 'private-fixture', providerId: 'traex', commandOverride: '/bin/sh', args: ['-c', 'sleep 30'], workspacePath: root, injectAgentMuxGuide: true })
    const launched = await (client as unknown as { kernel: { status(id: string): Promise<{ args: string[] }> } }).kernel.status(created.run.runId)
    const guideArgs = launched.args.filter(arg => arg.includes('AgentMux runtime guide:'))
    expect(guideArgs).toHaveLength(1)
    expect(guideArgs[0]).toContain(AGENTMUX_AGENT_MESSAGING_GUIDANCE)
    const output = JSON.parse((await exec(process.execPath, [cli, 'whoami'], { timeout: 15_000,
      env: { ...env, AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: created.agentSessionId } })).stdout)
    expect(output).toMatchObject({ ok: true, operation: 'whoami', result: {
      session: { agentSessionId: created.agentSessionId }, run: { runId: created.run.runId }, capabilities: { terminal: true },
      messaging: AGENTMUX_AGENT_MESSAGING_RULES } })
    expect(Object.keys(output.result.messaging)).toEqual(['crossSession', 'source', 'nativeSubagents', 'authenticity'])
    const skill = (await exec(process.execPath, [cli, '--skill'], { env })).stdout
    expect(skill).toContain(AGENTMUX_AGENT_MESSAGING_GUIDANCE)
    // This is the exact launch composition consumed by createAgentWithDelivery, with original body.
    const launch = composeAgentLaunchPrompt('original request', true).text
    expect(launch).toContain(AGENTMUX_AGENT_MESSAGING_GUIDANCE)
    expect(launch).toContain('"$AGENTMUX_CLI" whoami')
    expect(launch.endsWith('</amux>\n\noriginal request')).toBe(true)
  } finally {
    if (created) await client.stopAgent(created.agentSessionId, created.run).catch(() => {})
    await client.dispose()
    const owners = await owned()
    if (ownerPid !== undefined) expect(owners.map(owner => owner.pid)).toEqual([ownerPid])
    for (const { pid } of owners) process.kill(pid, 'SIGTERM')
    await vi.waitFor(async () => expect(await owned()).toEqual([]), { timeout: 5000, interval: 50 })
    process.stdout.write(`${JSON.stringify({ privateRuntime: root, stoppedOwnerPids: owners.map(owner => owner.pid) })}\n`)
    vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true })
  }
}, 30_000)
