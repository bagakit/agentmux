import { spawn } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSONRPCClient } from 'json-rpc-2.0'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { codexQuestionAnswers } from '../src/providers/codex-question.js'
import type { AgentMuxSessionQuestionReplyInput } from '../src/client.js'
import * as runner from '../src/process-runner.js'
import * as nativeProcess from '../src/agent-native-process.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'

// Source-only qualification launches the real original RPC listener worker.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  try {
    for (const close of cleanups.splice(0).reverse()) {
      try { await close() } catch (error) { failures.push(error) }
    }
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() }
  if (failures.length) throw new AggregateError(failures, 'Private question-queue test cleanup failed')
})

/** Real native question, queue storage, exact OS writer and model-input consumer.
 * Only Runtime status/byte IO is a fixture port; no user Run or real model is used. */
it.runIf(process.platform === 'darwin')('ordinary Codex queues SDK and CLI question answers during an active turn, then consumes each original operation once when idle', async () => {
  const h = await rpcOwnerFixture(['question-session']), root = h.root, home = join(root, 'native-home')
  cleanups.push(h.close)
  await mkdir(home)
  const command = process.env.AGENTMUX_TEST_CODEX_BINARY ?? 'codex'
  expect((await runner.runProcess(command, ['--version'], { timeoutMs: 3000 })).stdout.trim()).toBe('codex-cli 0.166.0')
  const helper = join(root, 'native-process-proof')
  expect(await runner.runProcess('cc', ['-Wall', '-Wextra', '-Werror',
    fileURLToPath(new URL('../native/native-socket-peer.c', import.meta.url)), '-lproc', '-o', helper], { timeoutMs: 10_000 }))
    .toMatchObject({ exitCode: 0, stderr: '' })
  const run = runner.runProcess
  vi.spyOn(runner, 'runProcess').mockImplementation((command, args, options) =>
    run(command.endsWith('/native-socket-peer-darwin') ? helper : command, args, options))
  // Fault-inject missing metadata observations, without closing native descriptors.
  const observeFiles = nativeProcess.nativeProcessFiles
  let omittedMetadata = 0
  vi.spyOn(nativeProcess, 'nativeProcessFiles').mockImplementation(async (...args) => {
    const files = await observeFiles(...args)
    omittedMetadata += files.filter(file => basename(file.path) === 'state_5.sqlite').length
    return files.filter(file => basename(file.path) !== 'state_5.sqlite')
  })

  const question = { title: 'PRIVATE_QUEUE choose how the original work should continue.', options: ['Keep the work', 'Review first'] }
  const callId = 'private-native-question-call', questionId = JSON.stringify(['request_user_input_async', callId, 0])
  const requests: Array<Record<string, any>> = [], inputs: string[] = [], sockets = new Set<import('node:net').Socket>()
  let activeResponse: ServerResponse | undefined
  const emit = (response: ServerResponse, value: unknown) => response.write('data: ' + JSON.stringify(value) + '\n\n')
  const complete = (response: ServerResponse, index: number, item: Record<string, any>) => {
    emit(response, { type: 'response.created', response: { id: 'private-response-' + index, status: 'in_progress', output: [] } })
    emit(response, { type: 'response.output_item.added', output_index: 0, item })
    emit(response, { type: 'response.output_item.done', output_index: 0, item })
    emit(response, { type: 'response.completed', response: { id: 'private-response-' + index, status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
    response.end()
  }
  const final = (response: ServerResponse, index: number) => complete(response, index, { type: 'message', id: 'private-answer-' + index,
    role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PRIVATE_QUEUE_COMPLETE', annotations: [] }] })
  const endpoint = createServer(async (request, response) => {
    if (request.method === 'GET') { response.setHeader('content-type', 'application/json'); response.end('{"data":[]}'); return }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const text = body.input?.filter((item: any) => item.role === 'user').at(-1)?.content?.map((part: any) => part.text ?? '').join('') ?? ''
    if (!text.includes('PRIVATE_QUEUE')) { response.setHeader('content-type', 'application/json'); response.end('{}'); return }
    requests.push(body); inputs.push(text)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requests.length === 1) return complete(response, 1, { type: 'function_call', id: 'private-question-item', call_id: callId,
      name: 'request_user_input_async', arguments: JSON.stringify({ questions: [question] }), status: 'completed' })
    if (requests.length === 2) { activeResponse = response; return }
    final(response, requests.length)
  })
  cleanups.push(async () => {
    activeResponse?.end()
    for (const socket of sockets) socket.destroy()
    if (endpoint.listening) await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()))
  })
  endpoint.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => { endpoint.once('error', reject); endpoint.listen(0, '127.0.0.1', resolve) })
  const address = endpoint.address(); if (!address || typeof address === 'string') throw new Error('Missing private model endpoint')
  // The native tool registry requires the model's explicit async-question capability.
  // This private model catalog supplies it through the native startup configuration.
  const catalog = join(home, 'models.json')
  await writeFile(catalog, JSON.stringify({ models: [{ slug: 'private-queue', display_name: 'Private question model',
    description: null, supported_reasoning_levels: [], shell_type: 'unified_exec', visibility: 'list', supported_in_api: true,
    priority: 0, availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null,
    truncation_policy: { mode: 'tokens', limit: 10_000 }, experimental_supported_tools: ['request_user_input_async'],
    model_messages: { instructions_template: 'Private offline protocol fixture. Follow the explicit user request.' } }] }))
  await writeFile(join(home, 'config.toml'), `model="private-queue"\nmodel_provider="private_queue"\nmodel_catalog_json=${JSON.stringify(catalog)}\n[model_providers.private_queue]\nname="Private offline question protocol"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`)

  const child = spawn(command, ['app-server', '--stdio'], { cwd: root, env: { ...process.env, CODEX_HOME: home, HOME: root },
    detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const events: Array<Record<string, any>> = [], calls: string[] = []
  let carry = '', diagnostic = '', ended = false, server: AgentMuxControlServer | undefined
  const native = new JSONRPCClient(value => new Promise<void>((resolve, reject) => {
    if ('method' in value && typeof value.method === 'string') calls.push(value.method)
    child.stdin.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve())
  }))
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-8192) })
  child.stdout.on('data', bytes => {
    carry += bytes.toString()
    for (let newline; (newline = carry.indexOf('\n')) >= 0;) {
      const line = carry.slice(0, newline); carry = carry.slice(newline + 1)
      if (!line.trim()) continue
      const value = JSON.parse(line)
      if (value.method) events.push(value); else native.receive(value)
    }
  })
  const closed = new Promise<void>(resolve => child.once('close', () => { ended = true; native.rejectAllPendingRequests(diagnostic); resolve() }))
  child.on('error', error => { diagnostic = String(error); native.rejectAllPendingRequests(diagnostic) })
  cleanups.push(async () => {
    child.stdin.end()
    const wait = async (): Promise<boolean> => {
      if (ended) return true
      let timer: NodeJS.Timeout | undefined
      try { return await Promise.race([closed.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000) })]) }
      finally { clearTimeout(timer) }
    }
    // This detached ChildProcess handle identifies only this test's native group.
    // A process that has already exited is never signalled by its reusable PID.
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (await wait()) return
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, signal) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
    }
    if (!await wait()) throw new Error(`Private native question backend did not close (PID ${child.pid}): ${diagnostic}`)
  })
  const call = (method: string, params: Record<string, unknown>) => native.timeout(10_000).request(method, params) as Promise<any>
  await call('initialize', { clientInfo: { name: 'agentmux_native_question_queue_proof', version: '1' }, capabilities: { experimentalApi: true } })
  native.notify('initialized', {}, undefined)
  const started = await call('thread/start', { cwd: root, threadSource: 'user', modelProvider: 'private_queue', model: 'private-queue', approvalPolicy: 'never', sandbox: 'read-only' })
  const nativeId = started.thread.id, initial = await call('turn/start', { threadId: nativeId, input: [{ type: 'text', text: 'PRIVATE_QUEUE_QUESTION_INITIAL' }] })
  await vi.waitFor(() => expect(activeResponse, JSON.stringify({ events: events.slice(-5), requests: requests.length, diagnostic })).toBeDefined(), { timeout: 15_000, interval: 50 })
  expect(JSON.stringify(requests[0]!.tools)).toContain('request_user_input_async')
  const read = await call('thread/read', { threadId: nativeId, includeTurns: false }), path = read.thread.path
  expect(read.thread).toMatchObject({ id: nativeId, status: { type: 'active' }, canAcceptDirectInput: true })
  const saved = (await h.store.readMetadata('question-session'))!
  await h.store.compareAndSwapMetadata(saved, { ...saved,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: nativeId, transcriptPath: path }, updatedAt: Date.now() })
  await h.inner.registry.load('local')
  h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), pid: child.pid!, program: command, args: ['app-server', '--stdio'] }))
  const page = await h.client.sessionHistoryPage('question-session', { limit: 100 })
  const record = page.items.find(item => item.questionRequest)
  expect(record?.questionRequest).toEqual({ delivery: 'async', questions: [{ id: questionId, prompt: question.title,
    options: question.options.map((label, index) => ({ id: String(index), label })), acceptsText: true }] })
  if (!record?.turnId) throw new Error('Real native async question was not recorded')
  const input: AgentMuxSessionQuestionReplyInput = { ...agentPromptCondition(h.client.agentSession('question-session')),
    agentSessionId: 'question-session', source: page.source, recordId: record.id, turnId: record.turnId,
    operationId: 'sdk-original-question-reply', answers: [{ questionId, answer: 'PRIVATE_QUEUE_SDK keep the original work' }] }
  const sdk = await h.client.replySessionQuestion(input)
  expect(await h.client.replySessionQuestion(input)).toEqual(sdk)
  const key = (submissionId: string) => ({ kind: 'prompt' as const, agentSessionId: 'question-session', expectedRun: saved.run, submissionId })
  const sdkClaim = await h.client.inspectAgentPromptSubmission(key(input.operationId))
  expect(sdkClaim?.admission).toMatchObject({ acknowledged: true, transport: 'native', native: { outcome: 'admitted',
    queuedSubmissionId: expect.any(String), plan: { protocolId: 'codex-durable-queue-0.163', operation: 'queue-idle', threadId: nativeId } } })

  server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: h.coreClients })
  cleanups.push(async () => { await server!.stop() })
  await server.start()
  const cliInput = { ...input, afterSubmissionId: input.operationId, operationId: 'cli-original-question-reply',
    answers: [{ questionId, answer: 'PRIVATE_QUEUE_CLI review the original direction' }] }
  const cli = () => runSourceObjectCli(['--endpoint', `unix:${server!.path}`, 'agent', 'question', 'reply', '--input', '-'], objectCliEnvironment(root), JSON.stringify(cliInput))
  const first = await cli(); expect(first.code, first.stderr + first.stdout).toBe(0)
  const repeated = await cli(); expect(repeated.code, repeated.stderr + repeated.stdout).toBe(0)
  expect(JSON.parse(repeated.stdout).result).toEqual(JSON.parse(first.stdout).result)
  const cliClaim = await h.client.inspectAgentPromptSubmission(key(cliInput.operationId))
  expect(cliClaim?.admission).toMatchObject({ acknowledged: true, transport: 'native', native: { outcome: 'admitted',
    queuedSubmissionId: expect.any(String), plan: { operation: 'queue-idle', threadId: nativeId } } })
  const queued = await call('thread/queue/list', { threadId: nativeId })
  expect(queued.data).toHaveLength(2)
  expect(omittedMetadata).toBeGreaterThan(0)
  expect(queued.data.map((item: any) => item.clientUserMessageId)).toEqual([
    sdkClaim!.admission!.native!.plan.clientCorrelation, cliClaim!.admission!.native!.plan.clientCorrelation ])
  expect(requests).toHaveLength(2)
  expect((await call('thread/read', { threadId: nativeId, includeTurns: false })).thread.status.type).toBe('active')
  expect(events.filter(event => event.method === 'turn/completed' && event.params.turn.id === initial.turn.id)).toHaveLength(0)
  expect(calls.filter(method => method === 'turn/start')).toHaveLength(1)
  expect(calls).not.toContain('turn/steer')

  final(activeResponse!, 2)
  const prompts = [sdkClaim!.admission!.intent!.prompt, cliClaim!.admission!.intent!.prompt]
  await vi.waitFor(() => {
    for (const prompt of prompts) expect(inputs.filter(text => text === prompt)).toHaveLength(1)
  }, { timeout: 20_000, interval: 100 })
  await vi.waitFor(async () => expect((await call('thread/queue/list', { threadId: nativeId })).data).toEqual([]), { timeout: 5000, interval: 50 })
  const history = await h.client.sessionHistoryPage('question-session', { limit: 100 })
  for (const [index, claim] of [sdkClaim, cliClaim].entries()) {
    const correlation = claim!.admission!.native!.plan.clientCorrelation
    const transcript = await readFile(path, 'utf8')
    const users = transcript.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'event_msg' &&
      row.payload.type === 'item_completed' && row.payload.item.type === 'UserMessage' && row.payload.item.client_id === correlation)
    expect(users).toHaveLength(1)
    expect(codexQuestionAnswers(users[0]!.payload.item.content)).toEqual([{ questionId, prompt: question.title,
      answer: index === 0 ? input.answers[0]!.answer : cliInput.answers[0]!.answer }])
    expect(history.items.filter(item => item.questionAnswers?.some(answer => answer.questionId === questionId &&
      answer.answer === (index === 0 ? input.answers[0]!.answer : cliInput.answers[0]!.answer)))).toHaveLength(1)
  }
  expect((await h.client.statusAgent('question-session')).run).toMatchObject({ runId: saved.run.runId, pid: child.pid!, state: 'running' })
  expect((await h.store.readMetadata('question-session'))?.nativeActor).toBeUndefined()
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.rawInput).not.toHaveBeenCalled()
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
}, 60_000)
