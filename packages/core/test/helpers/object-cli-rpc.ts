import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CliProbeRequest { jsonrpc: '2.0'; id: string | number; method: string; params: Record<string, unknown> }
export interface CliResult { code: number | null; stdout: string; stderr: string }
export function objectCliEnvironment(root: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
  return { ...clean, AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'), ...overrides }
}
export async function runCompiledObjectCli(args: readonly string[], env: NodeJS.ProcessEnv, stdin = ''): Promise<CliResult> {
  const cli = process.env.AGENTMUX_TEST_OBJECT_CLI ?? fileURLToPath(new URL('../../bin/agentmux', import.meta.url))
  const compiled = resolve(dirname(cli), '../dist/agentmux.js')
  if (!(await readFile(compiled)).byteLength) throw new Error('Compiled CLI is empty.')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Private CLI exceeded its bounded test deadline.')) }, 15_000)
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', text => { stdout += text }); child.stderr.on('data', text => { stderr += text })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.stdin.end(stdin)
  })
}
export class ObjectCliProbe {
  root = ''
  socketPath = ''
  inputPath = ''
  readonly requests: CliProbeRequest[] = []
  private server: Server | undefined
  private readonly sockets = new Set<Socket>()
  constructor(readonly handle: (request: CliProbeRequest, socket: Socket) => unknown | Promise<unknown> = request => {
    throw Object.assign(new Error('Captured canonical method ' + request.method), { code: 'CLI_ROUTE_PROBE' })
  }) {}
  async start(): Promise<void> {
    this.root = await mkdtemp(join(tmpdir(), 'oc-'))
    this.socketPath = join(this.root, 'control.sock')
    this.inputPath = join(this.root, 'input.json')
    await writeFile(this.inputPath, '{"changes":{"name":"raw"},"expected":{"name":"before"}}')
    this.server = createServer(socket => {
      this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket))
      let pending = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        pending += chunk
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
          if (!line) continue
          const request = JSON.parse(line) as CliProbeRequest
          this.requests.push(request)
          void Promise.resolve().then(() => this.handle(request, socket)).then(result => {
            if (result !== undefined) socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
          }, error => socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {
            code: -32000, message: error.message, data: { code: error.code, details: error.details, candidates: error.candidates }
          } }) + '\n'))
        }
      })
    })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.socketPath, resolve) })
  }
  environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return objectCliEnvironment(this.root, overrides)
  }
  async run(args: readonly string[], stdin = '', overrides: NodeJS.ProcessEnv = {}): Promise<CliResult> {
    return runCompiledObjectCli(args, this.environment(overrides), stdin)
  }
  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    if (this.server) await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()))
    if (this.root) await rm(this.root, { recursive: true, force: true })
  }
}

/** Argument fixtures are inputs; the command collection comes from actual registration. */
export function objectCliSeed(method: string, input: string): string[] {
  const ids = { agent: 'SID', region: 'R', zone: 'Z', space: 'S', goal: 'G' }
  const fixed: Record<string, string[]> = {
    whoami: [], 'agent.ls': [], 'agent.inspect': ['--session', ids.agent],
    'agent.context': ['--host', 'local', '--session', ids.agent],
    'message.pending.ls': ['--session', ids.agent],
    'message.pending.edit': ['--session', ids.agent, '--pending-id', 'PENDING', '--expected-text', 'before', '--text', '--help'],
    'message.pending.send': ['--session', ids.agent, '--pending-id', 'PENDING'],
    'message.pending.archive': ['--session', ids.agent, '--pending-id', 'PENDING', '--expected-text', 'before'],
    'message.pending.restore': ['--session', ids.agent, '--pending-id', 'PENDING', '--expected-text', 'before'],
    'device.ls': [], 'device.link': [], 'device.hello': ['--name', 'DEVICE'], 'device.revoke': ['--device', 'DEVICE'],
    'agent.open': ['--executor', 'E', '--zone', ids.zone, '--new-tab', '--operation-id', 'BUSINESS'],
    'agent.rename': ['--session', ids.agent, '--name', '--help'], 'agent.view': ['--session', ids.agent],
    'agent.reopen': ['--session', ids.agent, '--retired-at', '12', '--operation-id', 'REOPEN'],
    'agent.reopen.check': ['--session', ids.agent, '--retired-at', '12', '--operation-id', 'REOPEN'],
    'agent.output': ['--session', ids.agent], 'agent.send': ['--to-session', ids.agent, '--text', '--help'],
    'agent.discuss': ['--agent', 'E', '--text', 'task'], 'agent.handoff': ['--to-session', ids.agent, '--task', 'T'],
    'agent.interrupt': ['--session', ids.agent], 'agent.resume': ['--session', ids.agent, '--text', 'continue'], 'agent.stop': ['--session', ids.agent],
    'agent.role.ls': [], 'agent.role.register': ['--role', 'writer'], 'agent.role.resolve': ['--role', 'writer'],
    'space.state': [], 'space.commit': ['--revision', '0'],
    'space.resolve': ['--tab', 'TAB', '--region', ids.region, '--direction', 'left'],
    'space.ls': [], 'space.inspect': ['--region', ids.region], 'space.rename': ['--tab', 'TAB', '--clear'],
    'space.mv': ['--from-region', ids.region, '--expect-session', ids.agent, '--zone', ids.zone, '--new-tab'],
    'space.swap': ['--region', ids.region, '--with', 'R2'],
    'space.bind': ['--zone', ids.zone, '--space', ids.space], 'space.unbind': ['--zone', ids.zone, '--space', ids.space],
    'space.focus': ['--region', ids.region], 'space.promote': ['--region', ids.region], 'space.arrange': ['--tab', 'TAB', '--balance'],
    'file.open': ['--path', '--help', '--zone', ids.zone], 'file.view': ['--region', ids.region],
    'terminal.open': ['--in-region', ids.region], 'browser.open': ['--url', 'https://example.org', '--in-region', ids.region],
    'browser.targets': [], 'browser.run': ['--browser', 'B', '--operation-id', 'BOP'], 'browser.history': [],
    'browser.task.assets': ['--browser', 'B'], 'browser.task.reliability': ['--browser', 'B', '--asset', 'A', '--version', '1'],
    'browser.task.run': ['--browser', 'B', '--asset', 'A', '--version', '1'], 'browser.task.stop': ['--browser', 'B', '--run', 'RUN'],
    'browser.task.batch': ['--browser', 'B', '--asset', 'A', '--version', '1'], 'browser.task.batch-stop': ['--browser', 'B', '--batch', 'BATCH'],
    'browser.inspect': ['--operation-id', 'BOP'], 'browser.stop': ['--operation-id', 'BOP'],
    'browser.follow': ['--operation-id', 'BOP'], 'browser.replay': ['--browser', 'B', '--operation-id', 'BOP', '--preview'],
    'goal.ls': [], 'goal.inspect': ['--goal', ids.goal], 'goal.create': ['--title', 'Task', '--project', 'P', '--risk', 'low', '--confirm', 'user'],
    'goal.update': ['--goal', ids.goal, '--description', '--help'], 'goal.delete': ['--goal', ids.goal, '--confirm', 'delete'],
    'goal.assign': ['--goal', ids.goal, '--executor', 'E'], 'goal.start': ['--goal', ids.goal], 'goal.handoff': ['--goal', ids.goal],
    'goal.focus': ['--goal', ids.goal], 'goal.link-session': ['--goal', ids.goal, '--session', ids.agent],
    'goal.link-project': ['--goal', ids.goal, '--project', 'P'], 'goal.decisions': ['--goal', ids.goal], 'goal.activity': [],
    'message.inbox.check': ['--limit', '5'], 'message.inbox.ack': ['--generation', '3', '--reader-run', 'RUN'],
    'message.dispatch.open': ['--source-message', 'M'], 'message.dispatch.inspect': ['--source-message', 'M'],
    'message.dispatch.report': ['--source-message', 'M', '--reply-message', 'REPLY', '--kind', 'worker_done'],
    'app.inspect': [], 'app.snapshot': [], 'app.focus': ['--surface', 'space'], 'mote.playbook.pmo': [],
    'settings.inspect': [], 'settings.set': ['client.label', '--help'], 'settings.executors.refresh': ['E', '--host', '--help'],
    'settings.hosts.ls': [], 'settings.hosts.test': ['--help'], 'settings.workspaces.register': ['--input', input],
    'settings.browser-links.ls': [], 'settings.browser-links.forget': ['--help'],
    'system.doctor': [], 'system.endpoint': [], 'system.storage': ['--host', 'local', '--run', 'RUN'], 'system.crash-log.inspect': [], 'system.crash-log.reveal': [],
    'system.metrics.get': [], 'system.metrics.watch': []
  }
  const found = fixed[method]
  if (found) return found
  if (method.startsWith('settings.executors.') || method.startsWith('settings.prompts.')) {
    const action = method.split('.').at(-1)
    return action === 'ls' ? [] : ['ID', ...(['create', 'update'].includes(action!) ? ['--input', input] : [])]
  }
  if (method.startsWith('toolkit.')) {
    const action = method.slice('toolkit.'.length)
    if (action === 'ls') return []
    if (action === 'action') return ['TOOL', 'ACTION', '--input', input]
    return ['TOOL', ...(['create', 'update'].includes(action) ? ['--input', input] : [])]
  }
  throw new Error(`Missing argv input for actual registered command ${method}`)
}
