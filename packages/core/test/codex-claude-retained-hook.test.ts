import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentHookServer } from '../src/hook-server.js'
import { prepareManagedHookRuntime } from '../src/managed-hook-runtime.js'
import { retainedHookEnvironment } from '../src/providers/shared.js'
import type { NativeHookEnvelope } from '../src/types.js'

const exec = promisify(execFile)
type Mode = 'allow-once' | 'reject-once' | 'no-decision'
type Body = Record<string, any>
const results: Body[] = []
const cleanups: Array<() => Promise<void>> = []
async function cleanup(): Promise<void> {
  vi.unstubAllEnvs()
  const errors: unknown[] = []
  while (cleanups.length) try { await cleanups.pop()!() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Private native proof cleanup failed')
}
afterEach(cleanup)
function sse(response: ServerResponse, values: Array<[string | undefined, Body]>): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [event, value] of values) response.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`)
  response.end()
}

function anthropic(response: ServerResponse, body: Body, marker: string): void {
  const prior = body.messages?.some((message: Body) => Array.isArray(message.content) && message.content.some((part: Body) => part.type === 'tool_result'))
  const content = prior ? { type: 'text', text: 'PRIVATE_RETAINED_HOOK_COMPLETE' } : {
    type: 'tool_use', id: 'toolu_private_retained_hook', name: 'Bash',
    input: { command: `printf PRIVATE_RETAINED_HOOK > '${marker}'`, description: 'Write the private native Hook proof marker' }
  }
  const message = { id: 'msg_private_retained_hook', type: 'message', role: 'assistant', model: body.model,
    content: [content], stop_reason: prior ? 'end_turn' : 'tool_use', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10 } }
  if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return }
  sse(response, [
    ['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { ...content, ...(prior ? { text: '' } : { input: {} }) } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: prior ? { type: 'text_delta', text: content.text } :
      { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } }],
    ['message_stop', { type: 'message_stop' }]
  ])
}

function responses(response: ServerResponse, body: Body, marker: string, sequence: number): void {
  const tools: Body[] = (body.tools ?? []).flatMap((tool: Body) => tool.type === 'namespace' ? tool.tools : [tool])
  // Native auxiliary requests (for example a thread title) have no tools.
  const prior = !tools.length || body.input?.some((part: Body) => part.type === 'function_call_output')
  const name = ['exec_command', 'shell_command', 'shell'].find(candidate => tools.some(tool => tool.name === candidate))
  if (!prior && !name) throw Error(`Native Responses request has no qualified local shell tool: ${tools.map(tool => tool.name).join(',')}`)
  const command = `printf PRIVATE_RETAINED_HOOK > '${marker}'`
  const args = name === 'exec_command' ? { cmd: command, yield_time_ms: 1_000, max_output_tokens: 100,
    sandbox_permissions: 'require_escalated', justification: 'May the private native Hook proof write its marker in this private workspace?' } :
    name === 'shell_command' ? { command } : { command: ['/bin/sh', '-c', command] }
  const item: Body = prior ? { type: 'message', id: `msg_private_${sequence}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'PRIVATE_RETAINED_HOOK_COMPLETE', annotations: [] }] } : {
    type: 'function_call', id: `fc_private_${sequence}`, call_id: `private_retained_call_${sequence}`, name,
    arguments: JSON.stringify(args), status: 'completed' }
  const id = `resp_private_${sequence}`
  sse(response, [
    [undefined, { type: 'response.created', response: { id, status: 'in_progress', output: [] } }],
    [undefined, { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(prior ? { content: [] } : { arguments: '' }) } }],
    ...(!prior ? [[undefined, { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments }],
      [undefined, { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments }]] as Array<[undefined, Body]> : []),
    [undefined, { type: 'response.output_item.done', output_index: 0, item }],
    [undefined, { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]
  ])
}

it.each([
  ['codex', 'allow-once'], ['codex', 'reject-once'], ['codex', 'no-decision'],
  ['claude', 'allow-once'], ['claude', 'reject-once'], ['claude', 'no-decision']
] as const)('real %s loads its production launch carrier and retained callback (%s)', async (providerId, mode: Mode) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-codex-claude-retained-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), home = join(root, 'home'), state = join(root, 'state'), source = join(root, 'private-source')
  const marker = join(workspace, 'tool-executed'), acknowledgement = join(root, 'accepted')
  for (const path of [workspace, home, state, source]) await mkdir(path)
  const native = (await exec('which', [providerId])).stdout.trim()
  const version = (await exec(native, ['--version'], { env: { PATH: process.env.PATH, HOME: home } })).stdout.trim()
  const executablePath = join(source, 'node'), workerPath = join(source, 'worker.mjs')
  if (process.platform === 'darwin') await exec('/bin/cp', ['-c', process.execPath, executablePath])
  else await copyFile(process.execPath, executablePath, constants.COPYFILE_FICLONE)
  await copyFile(fileURLToPath(new URL('../dist/agentmux-hook.mjs', import.meta.url)), workerPath)
  const runtime = await prepareManagedHookRuntime(state, { executablePath, workerPath })
  await rm(source, { recursive: true })
  await expect(readFile(workerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(executablePath)).rejects.toMatchObject({ code: 'ENOENT' })
  const provider = new AgentProviderRegistry().get(providerId), observed: NativeHookEnvelope[] = [], decisions: string[] = []
  const permissionOutput = mode === 'no-decision' ? undefined : provider.hook?.permissionDecision?.outputs[mode]
  let deliveryError: unknown
  const ingress = new AgentHookServer(event => {
    observed.push(event)
    if (event.permissionCallback && permissionOutput) {
      queueMicrotask(() => { void ingress.respondPermission(event.agentSessionId, event.runId, event.receiptId, permissionOutput)
        .then(() => { decisions.push(event.receiptId) }, error => { deliveryError = error }) })
      return { permissionCallbackAccepted: true }
    }
  }, 0, {}, (id, name) => id === providerId && name === provider.hook?.permissionDecision?.eventName ? 'permission' : undefined)
  await ingress.start()
  cleanups.push(() => ingress.stop())
  const binding = ingress.createBinding(`original-${providerId}-${mode}`, providerId); await binding.bindRun(`original-run-${providerId}-${mode}`)
  const modelRequests: Body[] = [], modelErrors: string[] = []
  const backend = createServer((request, response) => {
    if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return }
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (request.url?.includes('count_tokens')) { response.writeHead(200); response.end('{"input_tokens":100}'); return }
        modelRequests.push(body)
        if (providerId === 'claude') anthropic(response, body, marker)
        else responses(response, body, marker, modelRequests.length)
      } catch (error) { modelErrors.push(String(error)); response.writeHead(500); response.end('{}') }
    })
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())) })
  const address = backend.address(); if (!address || typeof address === 'string') throw Error('Private backend did not bind')
  const base = `http://127.0.0.1:${address.port}`
  const env: Record<string, string> = { PATH: process.env.PATH!, HOME: home, LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    COLUMNS: '120', LINES: '40', AGENTMUX_STATE_DIRECTORY: state, AGENTMUX_ENV: '1', AGENTMUX_PROVIDER_ID: providerId,
    AGENTMUX_HOOK_PAYLOAD_KEY: 'hook_event_name', AGENTMUX_HOOK_URL: binding.endpoint.url, AGENTMUX_HOOK_TOKEN: binding.endpoint.token }
  let args: string[]
  if (providerId === 'claude') {
    const config = join(home, 'claude'); await mkdir(config)
    Object.assign(env, { CLAUDE_CONFIG_DIR: config, ANTHROPIC_AUTH_TOKEN: 'private-retained-hook-token', ANTHROPIC_BASE_URL: base,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_SKIP_UPDATE_CHECK: '1' })
    await writeFile(join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
      projects: { [workspace]: { hasTrustDialogAccepted: true } }, apiKeyResponses: { approved: [], rejected: [] } }))
    await mkdir(join(workspace, '.claude'))
    await writeFile(join(workspace, '.claude/settings.json'), '{"permissions":{"ask":["Bash"]}}')
    args = ['--model', 'claude-sonnet-4-5', '--']
  } else {
    const config = join(home, 'codex'); await mkdir(config); env.CODEX_HOME = config
    await writeFile(join(config, 'config.toml'), `model="private-retained-hook"\nmodel_provider="private_retained_hook"\n` +
      `[model_providers.private_retained_hook]\nname="Private localhost Hook proof"\nbase_url="${base}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n` +
      `[projects.${JSON.stringify(workspace)}]\ntrust_level="trusted"\n`)
    args = ['--dangerously-bypass-hook-trust', '--no-alt-screen', '-s', 'workspace-write', '-a', 'on-request']
  }
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  const plan = provider.buildLaunch({ workspacePath: workspace, prompt: 'Run the private Hook proof command once, then finish.', args, env, commandOverride: native })
  const managed = provider.planManagedHooks?.({ workspacePath: workspace, env })
  if (managed) for (const mutation of managed.mutations) {
    expect(mutation.path.startsWith(state + '/')).toBe(true)
    await mkdir(dirname(mutation.path), { recursive: true }); await writeFile(mutation.path, mutation.content, { mode: mutation.mode })
  }
  Object.assign(plan.env, retainedHookEnvironment(true, true, runtime))
  vi.unstubAllEnvs()
  let nativeInspection: Body | undefined
  if (providerId === 'codex') {
    const inspection = provider.buildLaunch({ workspacePath: workspace, prompt: '', args: ['--dangerously-bypass-hook-trust'], env, commandOverride: native })
    const privateReadEnv = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])), ...env, ...retainedHookEnvironment(true, true, runtime) }
    nativeInspection = await provider.inspectHookActivation!({ workspacePath: workspace, command: native, args: inspection.args,
      env: privateReadEnv, plan: { providerId, mutations: [] }, signal: AbortSignal.timeout(15_000) })
    expect(nativeInspection).toMatchObject({ active: true, code: 'HOOK_NATIVE_CURRENT_AND_TRUSTED' })
  }
  const input = join(root, 'input.json')
  await writeFile(input, JSON.stringify({ command: plan.command, args: plan.args, env: plan.env, workspace,
    acknowledgement, terminal: join(root, 'terminal.log') }), { mode: 0o600 })
  const child = spawn('python3', [fileURLToPath(new URL('./fixtures/codex-claude-retained-hook.py', import.meta.url)), input], { stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close'); let stderr = '', nativeAlive = false, cleaned = false, nativePid: number | undefined
  child.stderr.on('data', bytes => { stderr += bytes.toString() })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => { const value = JSON.parse(line); if (value.phase === 'started') { nativeAlive = true; nativePid = value.pid }
    if (value.phase === 'cleaned') { cleaned = value.childrenReaped; nativeAlive = false } })
  cleanups.push(async () => {
    await writeFile(acknowledgement, 'finish private native proof')
    if (child.exitCode === null) await closed
    lines.close()
    expect(cleaned, `Private native child cleanup unconfirmed: ${stderr}`).toBe(true)
  })
  let completed: Body | undefined
  try {
    await expect.poll(() => observed.map(event => event.eventName), { timeout: 50_000 }).toContain('PreToolUse')
    await expect.poll(() => observed.map(event => event.eventName), { timeout: 15_000 }).toContain('PermissionRequest')
    if (mode === 'no-decision') {
      await new Promise(resolve => setTimeout(resolve, 500))
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(nativeAlive).toBe(true); expect(decisions).toHaveLength(0)
      expect(nativePid).toBeGreaterThan(0); process.kill(nativePid!, 0)
      expect(observed.map(event => event.eventName)).not.toContain('PostToolUse')
      expect(modelRequests.some(body => body.input?.some((part: Body) => part.type === 'function_call_output'))).toBe(false)
    } else {
      await expect.poll(() => observed.map(event => event.eventName), { timeout: 25_000 }).toContain('Stop')
      if (mode === 'allow-once') expect(await readFile(marker, 'utf8')).toBe('PRIVATE_RETAINED_HOOK')
      else {
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
        if (providerId === 'claude') expect(modelRequests.some(body => body.messages?.some((message: Body) => Array.isArray(message.content) &&
          message.content.some((part: Body) => part.type === 'tool_result' && part.is_error === true)))).toBe(true)
        else expect(modelRequests.flatMap(body => body.input ?? []).filter(part => part.type === 'function_call_output'))
          .toEqual(expect.arrayContaining([expect.objectContaining({ output: expect.stringMatching(/reject/iu) })]))
      }
      expect(decisions).toHaveLength(1)
    }
    expect(modelRequests.length).toBeGreaterThan(0); expect(modelErrors).toEqual([]); expect(deliveryError).toBeUndefined()
    const permissionRequests = observed.filter(event => event.eventName === 'PermissionRequest')
    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0]?.permissionCallback).toBeDefined()
    expect(observed.map(event => event.eventName)).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PreToolUse']))
    if (mode === 'allow-once') expect(observed.map(event => event.eventName)).toContain('PostToolUse')
    for (const event of observed) expect(event).toMatchObject({ providerId, agentSessionId: `original-${providerId}-${mode}`, runId: `original-run-${providerId}-${mode}` })
    const ids = new Set(observed.filter(event => ['SessionStart', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop'].includes(event.eventName ?? '')).map(event => event.payload?.session_id))
    expect(ids.size).toBe(1); expect(ids.has(undefined)).toBe(false)
    completed = { providerId, mode, version, nativePid, originalNativeSessionId: [...ids][0], events: observed.map(event => event.eventName),
      modelRequests: modelRequests.length, privateSourceRemoved: true, retainedWorker: runtime.runnerPath, retainedNode: runtime.nodePath,
      decisionsReturned: decisions.length, nativeInspection, permissionRequests: permissionRequests.length,
      nativePermissionPayload: permissionRequests[0]!.payload, nativeDecision: permissionOutput ?? null,
      nativeToolFeedback: providerId === 'codex' ? modelRequests.flatMap(body => body.input ?? []).filter(part => part.type === 'function_call_output') :
        modelRequests.flatMap(body => body.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'tool_result'),
      markerExecuted: mode === 'allow-once', nativeWaitPreserved: mode === 'no-decision',
      scope: 'Production Provider launch through native TUI and retained worker to original authenticated HookServer; not Core.createAgent/ctxmux.' }
  } finally {
    await cleanup()
  }
  results.push({ ...completed, childrenReaped: cleaned })
  if (process.env.AGENTMUX_CODEX_CLAUDE_RECEIPT) await writeFile(process.env.AGENTMUX_CODEX_CLAUDE_RECEIPT, JSON.stringify(results, null, 2) + '\n')
})
