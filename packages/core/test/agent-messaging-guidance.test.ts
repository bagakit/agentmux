import { fixturePath } from './helpers/fixture-values.js'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { DOMParser } from '@xmldom/xmldom'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient as DefaultClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore as DefaultStore } from '../src/agent-session-store.js'
import { composeAgentLaunchPrompt } from '../src/agent-outbound-message.js'
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE, AGENTMUX_AGENT_MESSAGING_ENTRY } from '../src/agent-messaging-guidance.js'
import { AgentMuxControlServer as DefaultControlServer } from '../src/control-host.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

const exec = promisify(execFile)
const owner = process.env.AGENTMUX_TEST_GUIDANCE_CORE ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_GUIDANCE_CORE) : null
const AgentMuxClient: typeof DefaultClient = owner?.AgentMuxClient ?? DefaultClient
const AgentMuxFileAgentSessionStore: typeof DefaultStore = owner?.AgentMuxFileAgentSessionStore ?? DefaultStore
const AgentMuxControlServer: typeof DefaultControlServer = process.env.AGENTMUX_TEST_GUIDANCE_SERVER
  ? (await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_GUIDANCE_SERVER)).AgentMuxControlServer : DefaultControlServer
const cli = process.env.AGENTMUX_TEST_GUIDANCE_CLI ?? fileURLToPath(new URL('../bin/amux', import.meta.url))
const clientBin = fileURLToPath(new URL('../bin', process.env.AGENTMUX_TEST_GUIDANCE_CORE ?? import.meta.url))
const daemon = process.env.AGENTMUX_TEST_GUIDANCE_DAEMON ?? fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url))
const assertBrowserPlacement = (guide: string) => {
  const text = guide.replace(/\s+/gu, ' ')
  expect(text).toContain("prefer AgentMux's embedded Browser and public CLI")
  expect(text).toContain('Reuse the exact Browser already confirmed for this task')
  expect(text).toContain("inspect your own actual Tab/Region and the whole Tab's visible layout")
  expect(text).toContain('prefer a directional Region in that same Tab')
  expect(text).toContain('Agent and page stay readable together')
  expect(text).toContain('Choose the direction from actual geometry and content')
  expect(text).toContain('crowded layout, a full workface for reading, an unsuitable capability or a user-specified Browser/tool')
  expect(text).toContain('related new Tab or the specified tool')
  expect(text).toContain('briefly explain the reason and location')
  expect(text).toContain('does not authorize replacing existing content, changing focus, taking human control or bypassing refusal')
  expect(text).toContain('Keep the original page, user input and unknown operation receipts')
  expect(text).toContain('confirm the returned Browser, Tab, Region and navigation receipt')
}
it('real creation and CLI disclose only the task entry, with complete rules available on demand', async () => {
  const root = await mkdtemp(fixturePath("tmp/amux-messaging-guidance-")), storePath = join(root, 'sessions.json')
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('AGENTMUX_') || name.startsWith('CTXMUX_')) vi.stubEnv(name, undefined)
  }
  const env = { ...objectCliEnvironment(root), AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: storePath, AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
  for (const name of ['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_AGENT_SESSION_STORE', 'AGENTMUX_MESSAGE_QUEUE_PATH']) vi.stubEnv(name, env[name as keyof typeof env])
  const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(storePath) })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'runtime', 'control.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await mkdir(join(root, 'runtime'), { recursive: true, mode: 0o700 }); await mkdir(join(root, 'state/ctxmux'), { recursive: true, mode: 0o700 })
  const daemonProcess = spawn(daemon, ['--socket', join(root, 'runtime/ctxmux.sock'), '--state-dir', join(root, 'state/ctxmux'), '--readiness-fd', '3'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonError = ''; daemonProcess.stderr!.on('data', data => { daemonError += data })
  let created: Awaited<ReturnType<typeof client.createAgent>> | undefined
  let terminal: Awaited<ReturnType<typeof client.createTerminal>> | undefined
  try {
    await Promise.race([once(daemonProcess.stdio[3]!, 'data'), once(daemonProcess, 'exit').then(() => { throw Error(daemonError) })])
    await client.connect()
    await server.start()
    expect(daemonProcess.pid).toBeGreaterThan(0)
    const capture = join(root, 'issued.json'), agent = join(root, 'fixture-agent.mjs')
    const fixture = (destination: string) => `import { writeFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process'; const invoke = command => { const result = spawnSync(command, ['system', 'endpoint'], {encoding: 'utf8'}); return {status: result.status, stdout: result.stdout, error: result.error?.code}; }; writeFileSync(${JSON.stringify(destination)}, JSON.stringify({ agentSessionId: process.env.AGENTMUX_AGENT_SESSION_ID, capability: process.env.AGENTMUX_AGENT_CAPABILITY, args: process.argv.slice(2), cli: process.env.AGENTMUX_CLI, path: process.env.PATH, injected: invoke(process.env.AGENTMUX_CLI), discovered: invoke('amux') })); setInterval(() => {}, 1000);\n`
    await writeFile(agent, fixture(capture))
    created = await client.createAgent({ agentSessionId: 'private-discovery-agent', createOperationId: 'private-discovery-create',
      executorId: 'private-fixture', providerId: 'traex', commandOverride: process.execPath, args: [agent], workspacePath: root, injectAgentMuxGuide: true })
    let issued!: { agentSessionId: string; capability: string; args: string[]; cli: string; path: string; injected: {status: number; stdout: string}; discovered: {status: number; stdout: string} }
    await vi.waitFor(async () => {
      issued = JSON.parse(await readFile(capture, 'utf8'))
      expect(issued).toMatchObject({ agentSessionId: created!.agentSessionId, capability: expect.any(String), args: expect.any(Array) })
      expect(issued.capability.length).toBeGreaterThan(0)
    }, { timeout: 5000, interval: 20 })
    const assertCli = (child: Pick<typeof issued, 'cli' | 'path' | 'injected' | 'discovered'>) => {
      expect(child.cli).toBe(join(clientBin, 'amux'))
      expect(child.path.split(':')[0]).toBe(clientBin)
      for (const result of [child.injected, child.discovered]) {
        expect(result.status).toBe(0)
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, operation: 'system.endpoint' })
      }
    }
    assertCli(issued)
    const terminalCapture = join(root, 'terminal-issued.json'), terminalFixture = join(root, 'fixture-terminal.mjs')
    await writeFile(terminalFixture, fixture(terminalCapture))
    terminal = await client.createTerminal({ createOperationId: 'private-cli-terminal', workspacePath: root, command: process.execPath, args: [terminalFixture] })
    await vi.waitFor(async () => assertCli(JSON.parse(await readFile(terminalCapture, 'utf8'))), { timeout: 5000, interval: 20 })
    const launched = await (client as unknown as { kernel: { status(id: string): Promise<{ args: string[] }> } }).kernel.status(created.run.runId)
    const guideArgs = launched.args.filter(arg => arg.includes('AgentMux runtime guide:'))
    expect(guideArgs).toHaveLength(1)
    expect(issued.args.filter(arg => arg.includes('AgentMux runtime guide:'))).toEqual(guideArgs)
    const envelope = new DOMParser().parseFromString(guideArgs[0]!, 'text/xml').documentElement!
    expect(envelope.tagName).toBe('amux')
    expect(envelope.attributes.length).toBe(0)
    const receivedContext = envelope.textContent!
    expect(receivedContext).toBe(`\n${composeAgentLaunchPrompt(undefined, true).systemContext}\n`)
    expect(receivedContext).toContain(AGENTMUX_AGENT_MESSAGING_ENTRY)
    expect(receivedContext).not.toContain(AGENTMUX_AGENT_MESSAGING_GUIDANCE)
    expect(receivedContext).toContain('Load only the relevant')
    expect(receivedContext).toContain('browser --skill first')
    expect(receivedContext).toContain('read space --skill')
    expect(receivedContext.length).toBeLessThan(1800)
    const whoami = await exec(process.execPath, [cli, 'whoami'], { timeout: 15_000,
      env: { ...env, AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: created.agentSessionId, AGENTMUX_AGENT_CAPABILITY: issued.capability } })
      .then(result => ({ ...result, code: 0 }), error => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }))
    expect(whoami.code, whoami.stderr).toBe(0)
    const output = JSON.parse(whoami.stdout)
    expect(output).toMatchObject({ ok: true, operation: 'whoami', result: {
      session: { agentSessionId: created.agentSessionId, run: { runId: created.run.runId } },
      status: { run: { runId: created.run.runId }, capabilities: { terminal: true } } } })
    expect(JSON.stringify(output)).not.toContain(issued.capability)
    const readings: Record<string, string> = {}
    for (const args of [['--skill'], ['agent', '--skill'], ['message', '--skill'], ['--help'], ['--help', 'agent', 'send'], ['--help', 'message', 'read']]) {
      const guide = (await exec(process.execPath, [cli, ...args], { env })).stdout
      readings[args.join(' ')] = guide
      if (args.join(' ') === 'message --skill') expect(guide).toContain(AGENTMUX_AGENT_MESSAGING_GUIDANCE)
      else expect(guide, args.join(' ')).not.toContain(AGENTMUX_AGENT_MESSAGING_GUIDANCE)
    }
    expect(readings['--skill']).toContain('amux message --skill')
    expect(readings['agent --skill']).toContain('message --skill')
    expect(readings['--help agent send']).toContain('Read amux message --skill before communicating')
    const spaceSkill = (await exec(process.execPath, [cli, 'space', '--skill'], { env })).stdout
    const openingStart = spaceSkill.indexOf('## Delegation and opening playbook (advisory)')
    const openingEnd = spaceSkill.indexOf('## Read an amux object link', openingStart)
    expect(openingStart).toBeGreaterThanOrEqual(0)
    expect(openingEnd).toBeGreaterThan(openingStart)
    const opening = spaceSkill.slice(openingStart, openingEnd).trim()
    expect(opening).toMatch(/Provider-native delegation[\s\S]*independent AgentMux Session/)
    expect(opening).toMatch(/Agent or file[\s\S]*same-Tab split[\s\S]*new Tab/)
    expect(opening).toMatch(/real order[\s\S]*do not offer before\/after Tab flags/)
    expect(opening).toContain('advisory strategies')
    assertBrowserPlacement(opening)
    for (const object of ['agent', 'file']) {
      const help = (await exec(process.execPath, [cli, '--help', object, 'open'], { env })).stdout
      expect(help).toContain('amux space --skill')
      expect(help).not.toContain(opening)
    }
    // This is the exact launch composition consumed by createAgentWithDelivery, with original body.
    const launch = composeAgentLaunchPrompt('original request', true)
    expect(launch.systemContext).toContain(AGENTMUX_AGENT_MESSAGING_ENTRY)
    expect(launch.systemContext).not.toContain(AGENTMUX_AGENT_MESSAGING_GUIDANCE)
    expect(launch.systemContext).toContain('browser --skill first')
    expect(launch.systemContext).toContain('read space --skill')
    expect(launch.text).toContain('"$AGENTMUX_CLI" whoami')
    expect(launch.text.endsWith('</amux>\n\noriginal request')).toBe(true)
    // A bounded read path, not a tokenizer bill or universal model adoption claim.
    const lengths = Object.fromEntries(Object.entries(readings).map(([key, value]) => [key, [...value].length]))
    const discoveryPath = [...receivedContext].length + lengths['--skill']! + lengths['agent --skill']! + lengths['message --skill']! + lengths['--help agent send']!
    expect(discoveryPath).toBeLessThan(18_000)
    process.stdout.write(JSON.stringify({ disclosureCharacters: { startup: [...receivedContext].length, ...lengths,
      actualWhoamiJson: [...whoami.stdout].length, discoveryPath }, runtimeFixture: true, modelAdoption: false }) + '\n')
  } finally {
    await server.stop()
    if (terminal) await client.stopTerminal({ runId: terminal.runId }).catch(() => {})
    if (created) await client.stopAgent(created.agentSessionId, created.run).catch(() => {})
    await client.dispose()
    const exited = daemonProcess.exitCode === null && daemonProcess.signalCode === null ? once(daemonProcess, 'exit') : null
    if (exited) { daemonProcess.kill('SIGTERM'); await exited }
    process.stdout.write(`${JSON.stringify({ privateRuntime: root, stoppedOwnerPids: [daemonProcess.pid] })}\n`)
    vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true })
  }
}, 30_000)
