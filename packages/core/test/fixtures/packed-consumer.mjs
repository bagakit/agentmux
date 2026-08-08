import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  AgentMuxControlServer,
  AgentMuxFileAgentSessionStore,
  connectLocalAgentMux,
  connectSshAgentMux,
  requestAgentMuxControl
} from '@agentmux/core'
import {
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  resolveAgentMuxRegion
} from '@agentmux/core/control'
import { normalizeAgentTimelineMutation } from '@agentmux/core/timeline'

const execFileAsync = promisify(execFile)

// 打进包里的 CLI 版本号唯一真相是**已安装的** @agentmux/core/package.json 的 `version`——不是本仓源码，
// 而是这个消费者 node_modules 里那一份。这里从已解析的入口向上走到它的 package.json 读出来，作为
// `agentmux --version` 应当报告的期望值；绝不再写死一份 `0.1.0`。`@agentmux/core` 有 `exports` 且没有
// 暴露 `./package.json` 子路径，直接 import 会 ERR_PACKAGE_PATH_NOT_EXPORTED，所以从 `.` 入口的真实
// 位置向上找包根。控制夹具（ctxmux-terminal-control.mjs）真的 exec 了同一个已安装 CLI 的 `--version`，
// 于是这条把「安装出去的 CLI 报告的版本」钉成「安装出去的包声明的版本」——bump 包版本两边一起动，
// 把源码改回硬编码就会与声明分叉。
const installedCoreVersion = (() => {
  let directory = dirname(fileURLToPath(import.meta.resolve('@agentmux/core')))
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      if (manifest.name === '@agentmux/core') return manifest.version
    } catch {}
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error('packed-consumer 无法定位已安装的 @agentmux/core/package.json')
})()
assert.equal(typeof installedCoreVersion, 'string')
assert.ok(installedCoreVersion.length > 0)

const controlFixture = process.env.AGENTMUX_CONTROL_FIXTURE
const stubbornFixture = process.env.AGENTMUX_STUBBORN_FIXTURE
const fakeCodex = process.env.AGENTMUX_FAKE_CODEX
const agentmuxCli = process.env.AGENTMUX_CLI_PATH
const lifecycleCrashFixture = process.env.AGENTMUX_LIFECYCLE_CRASH_FIXTURE
const promptCrashFixture = process.env.AGENTMUX_PROMPT_CRASH_FIXTURE
const interactionCrashFixture = process.env.AGENTMUX_INTERACTION_CRASH_FIXTURE
assert.ok(
  controlFixture && stubbornFixture && fakeCodex && agentmuxCli &&
  lifecycleCrashFixture && promptCrashFixture && interactionCrashFixture
)

const ownedChildren = new Set()
function spawnOwned(...args) {
  const child = spawn(...args)
  ownedChildren.add(child)
  child.once('exit', () => ownedChildren.delete(child))
  return child
}
process.once('exit', () => {
  for (const child of ownedChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})
assert.deepEqual(
  resolveAgentMuxRegion(
    [{
      tabId: 'packed-agent-tab',
      regionId: 'packed-agent-region',
      kind: 'agent',
      agentSessionId: 'packed-agent',
      providerId: 'codex',
      executorId: 'codex',
      workspaceId: 'packed-workspace',
    }],
    { kind: 'agent-session', agentSessionId: 'packed-agent' }
  ),
  {
    tabId: 'packed-agent-tab',
    regionId: 'packed-agent-region',
    kind: 'agent',
    agentSessionId: 'packed-agent',
    providerId: 'codex',
    executorId: 'codex',
    workspaceId: 'packed-workspace',
  }
)
assert.throws(
  () => normalizeAgentTimelineMutation({
    type: 'update',
    agentSessionId: 'packed-agent',
    itemId: 'assistant-1',
    updatedAt: 1,
    contentDelta: 'legacy delta'
  }),
  (error) => error?.code === 'INVALID_AGENT_TIMELINE'
)

/**
 * 等某个条件成立。
 *
 * **没有挂钟预算。** 全部 54 处调用都是"等一件会到的事"，没有一处用超时表达"这件事不该发生"
 * （若要那样断言，写法是等对立事件成立，而不是等一个预算烧完）。上界由外层持有：跑这个脚本的
 * 那条 it 声明了 95 秒。
 *
 * 原先是 8 秒。它在机器被压满时先于外层触发，把"慢"报成"没发生"——这就是 test:native 那个负载相关
 * flake 的真正位点。实测 2026-09-01：负载 ~120 时同机解一个 84KB tarball 花了 3 分 42 秒挂钟、
 * 只用 0.01 秒 CPU（纯调度饥饿）；负载 ~15 时这条 8 秒预算 3 次里红 2 次。
 *
 * 两个预算守同一件事时，短的那个只贡献假阴性。
 *
 * `description` 保留，且**改成真卡住时唯一能读到的线索**：外层期限到了只会杀掉整个脚本，不会说它
 * 停在 54 个等待里的哪一个。所以每隔一段就把当前在等什么打到 stderr——诊断价值正是原先那条错误
 * 消息提供的东西，不该跟着预算一起删掉。
 */
async function waitFor(description, predicate) {
  const started = Date.now()
  let announced = 0
  for (;;) {
    const result = await predicate()
    if (result) return result
    const waited = Date.now() - started
    if (waited >= (announced + 1) * 10_000) {
      announced = Math.floor(waited / 10_000)
      process.stderr.write(`[packed-consumer] still waiting for ${description} (${Math.round(waited / 1000)}s)\n`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Reattach 一个 Agent，并把它 replay 出来的字节合进这个 client 的事件数组。
 *
 * **必须合流，不能只等 `terminal-output` 事件。** `attach` 把 attach **之前**的输出放进
 * `snapshot.replay`，只把之后的喂给推流；于是同一段字节要么是 replay 要么是事件，绝不两者都是。
 * 而 Agent 的握手（`ensureTerminalHandshake`）自己 attach 一次、在 `finally` 里 detach——attach 是
 * 排他的（第二次会 `ATTACHMENT_EXISTS`），所以它必须放手。那次 detach 与这里 reattach 之间就有一段
 * **没有任何监听者**的窗口，落在窗口里的输出此后只能以 replay 形式出现。
 *
 * 实测（2026-09-01）：在 `handshake race controlled composer pending` 之前插 3 秒延迟，让假 CLI 有
 * 充足时间在窗口里写完 `codex-controlled-ready-pending`，那条等待就从 1/3 概率永等变成 100% 永等。
 * 这不是负载 flake——负载只决定谁先跑完那一步，判据本身漏了半条流。
 *
 * 产品侧两个消费者都做了合流：Desktop 把 `replay` 交给 renderer 与实时事件拼接，CLI 走
 * `OrderedSessionOutputFollow`。只有这个 fixture 少了这一步，于是它测出的"输出"比任何真实消费者
 * 看到的都少。合流放在 `await` 之后同步 push，因此排在推流的实时事件之前——正是字节的真实次序。
 */
async function reattachAgentWithReplay(client, agentSessionId, events, afterByte = 0) {
  const { attachment } = await client.reattachAgent(agentSessionId, afterByte)
  for (const event of attachment.replay) {
    events.push({ type: 'terminal-output', run: { runId: event.runId }, data: event.data })
  }
  return attachment
}

function output(events, runId) {
  return events
    .filter((event) => event.type === 'terminal-output' && event.run.runId === runId)
    .map((event) => event.data)
    .join('')
}

async function processIsGone(pid) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return true
    throw error
  }
  return false
}

async function firstJsonLine(child, description) {
  let timer
  // worker 用 stdio ['ignore','pipe','pipe'] 起，但 stderr 从没人读——它一崩，死因就整个消失，
  // 只剩 "Child exited before reporting its lifecycle checkpoint."，指不到任何一行代码。
  // 边收边攒，失败时原样附上。
  let stderr = ''
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const withStderr = (message) => {
    const trailing = stderr.trim()
    return new Error(trailing ? `${message}\n--- ${description} stderr ---\n${trailing}` : message)
  }
  try {
    return await Promise.race([
      (async () => {
        let buffer = ''
        for await (const chunk of child.stdout) {
          buffer += chunk.toString('utf8')
          const newline = buffer.indexOf('\n')
          if (newline >= 0) return JSON.parse(buffer.slice(0, newline))
        }
        throw withStderr(`Child exited before reporting its ${description} lifecycle checkpoint.`)
      })(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          reject(withStderr(`Timed out waiting for ${description} lifecycle checkpoint.`))
        }, 5_000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function rawControlReceipt(path, message, splitAt) {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const chunks = []
    socket.once('connect', () => {
      const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
      socket.write(bytes.subarray(0, splitAt))
      setTimeout(() => socket.write(bytes.subarray(splitAt)), 10)
    })
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.once('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
    })
    socket.once('error', reject)
  })
}

let first = await connectLocalAgentMux()
assert.deepEqual(await first.listRuns(), [])
const ownerInstanceId = first.runtimeIdentity().instanceId
const firstEvents = []
first.onEvent((event) => firstEvents.push(event))
const run = await first.createTerminal({
  workspacePath: process.cwd(),
  command: process.execPath,
  args: [controlFixture],
  cols: 80,
  rows: 24
})
const firstAttachment = await first.attachTerminal(run.runId, 0)
assert.equal(firstAttachment.gap, null)
await waitFor('fragmented UTF-8 output', () => output(firstEvents, run.runId).includes('control-ready'))
assert.equal(
  output(firstEvents, run.runId).includes('terminal-env:xterm-256color:truecolor:color-enabled'),
  true
)
assert.equal(
  output(firstEvents, run.runId).includes(`agentmux-env:1:true:agentmux ${installedCoreVersion}`),
  true
)
assert.equal(output(firstEvents, run.runId).includes('prefix:😀:tail'), true)
assert.equal(output(firstEvents, run.runId).includes('�'), false)
const beforeReconnect = (await first.listRuns()).find((candidate) => candidate.runId === run.runId)
assert.ok(beforeReconnect)
assert.ok(beforeReconnect.pid)
const originalPid = beforeReconnect.pid
await first.dispose()
first = null

const second = await connectLocalAgentMux()
const reconnected = (await second.listRuns()).find((candidate) => candidate.runId === run.runId)
assert.ok(reconnected)
assert.equal(reconnected.runId, run.runId)
assert.equal(reconnected.pid, originalPid)
const secondEvents = []
second.onEvent((event) => secondEvents.push(event))
const suffix = await second.attachTerminal(run.runId, Buffer.byteLength('prefix:'))
assert.equal(suffix.gap, null)
assert.equal(suffix.replay[0]?.startByte, Buffer.byteLength('prefix:'))
assert.equal(suffix.replay.map((event) => event.data).join('').includes('😀:tail'), true)

const recoverableInput = {
  ownerInstanceId,
  operationId: 'packed-abandoned-input-response',
  expectedByte: reconnected.acceptedInputBytes,
  data: 'dedup-once\n'
}
// Deliberately discard the first receipt, then recover it through a fresh public Client.
await second.writeTerminal(run, recoverableInput)
await waitFor('first recoverable input', () => output(secondEvents, run.runId).includes('input:dedup-once'))
await second.dispose()

const third = await connectLocalAgentMux()
const thirdEvents = []
third.onEvent((event) => thirdEvents.push(event))
const fullReplay = await third.attachTerminal(run.runId, 0)
const sharedReplay = await third.readRunReplay(run, Buffer.byteLength('prefix:'))
assert.equal(sharedReplay.replay[0]?.startByte, Buffer.byteLength('prefix:'))
assert.equal(sharedReplay.replay.map((event) => event.data).join('').includes('😀:tail'), true)
const recoveredInput = await third.writeTerminal(run, recoverableInput)
assert.deepEqual(recoveredInput.appliedByteRange, {
  startByte: recoverableInput.expectedByte,
  endByte: recoverableInput.expectedByte + Buffer.byteLength(recoverableInput.data)
})
const followingInput = {
  ownerInstanceId,
  operationId: 'packed-following-input',
  expectedByte: recoveredInput.acceptedThroughByte,
  data: 'after-dedup\n'
}
await third.writeTerminal(run, followingInput)
await waitFor('following recoverable input', () => output(thirdEvents, run.runId).includes('input:after-dedup'))
const completeOutput = fullReplay.replay.map((event) => event.data).join('') + output(thirdEvents, run.runId)
const dedupOccurrences = completeOutput.match(/input:dedup-once/gu)?.length ?? 0
assert.equal(dedupOccurrences, 1)

await third.resizeTerminal(run, 101, 37)
await waitFor('applied resize', () => output(thirdEvents, run.runId).includes('size:101x37'))
await third.signalTerminal(run, 'SIGINT')
await waitFor('interrupt receipt from the still-live process', () => (
  output(thirdEvents, run.runId).includes('interrupt-observed')
))
assert.equal((await third.listRuns()).find((candidate) => candidate.runId === run.runId)?.state, 'running')
await third.stopTerminal(run)

const stubbornEvents = []
const unsubscribe = third.onEvent((event) => stubbornEvents.push(event))
const stubborn = await third.createTerminal({
  workspacePath: process.cwd(),
  command: process.execPath,
  args: [stubbornFixture]
})
await third.attachTerminal(stubborn.runId, 0)
const stubbornOutput = await waitFor('stubborn process tree identities', () => {
  const text = output(stubbornEvents, stubborn.runId)
  return text.includes('stubborn-root:') && text.includes('stubborn-child:') ? text : null
})
const rootMatch = /stubborn-root:(\d+):(\d+)/u.exec(stubbornOutput)
const childMatch = /stubborn-child:(\d+)/u.exec(stubbornOutput)
assert.ok(rootMatch && childMatch)
const stubbornPids = [Number(rootMatch[1]), Number(rootMatch[2]), Number(childMatch[1])]
await third.stopTerminal(stubborn)
await waitFor('complete stubborn process-tree stop', async () => (
  (await Promise.all(stubbornPids.map(processIsGone))).every(Boolean)
))
unsubscribe()

/**
 * 跑一次打包出来的 `agentmux` CLI。
 *
 * **没有挂钟预算。** 原先是 `timeout: 15_000`，20 处调用共用。实测（2026-09-01）健康情况下全部 20 次
 * 里最慢的是 `resume` 的 **191ms**；而负载 ~20 时它撞满 15 秒被 SIGTERM 杀掉——**79 倍**。
 * 这不是"界定一个慢操作"，是调度饥饿下杀死一个健康进程，与这个 fixture 里其余被删掉的预算同一个判断：
 * 两个预算守同一件事时，短的那个只贡献假阴性。上界由外层持有（跑这个脚本的那条 it 声明了 95 秒）。
 *
 * 这一族假阴性尤其难认，因为 `execFile` 超时的报错**从不说它超时了**：实测 message 只有
 * `Command failed: <argv>`，靠 `killed: true` / `signal: 'SIGTERM'` / `code: null` 才认得出。
 * 于是它长得就像"CLI 自己失败了"，而 stdout/stderr 都是空的。
 */
const cli = async (args, env = {}) => await execFileAsync(agentmuxCli, args, {
  maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, ...env }
})
let codexFirst = await connectLocalAgentMux()
const codexFirstEvents = []
const codexTimelinePublicationSnapshots = []
codexFirst.onEvent((event) => {
  codexFirstEvents.push(event)
  if (event.type === 'agent-timeline') {
    codexTimelinePublicationSnapshots.push(
      codexFirst.sessionTimeline(event.agentSessionId).then((snapshot) => ({ event, snapshot }))
    )
  }
})
const codex = await codexFirst.createAgent({
  agentSessionId: 'codex-semantic-1',
  createOperationId: `packed-codex-${crypto.randomUUID()}`,
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  prompt: 'first',
  commandOverride: fakeCodex,
  env: {
    AGENTMUX_FAKE_PROMPT_RENDER_MODE: 'historical-match',
    AGENTMUX_FAKE_PERMISSION_REQUEST: '1'
  }
})
assert.equal('hookBindingId' in codex, false)
assert.equal('hookToken' in codex, false)
assert.equal('hookBindingId' in codexFirst.agentSessions()[0], false)
assert.equal('hookToken' in codexFirst.agentSessions()[0], false)
const codexSubject = (await codexFirst.runtimeProjection()).subjects.find((subject) => subject.kind === 'agent')
assert.ok(codexSubject)
assert.equal('hookBindingId' in codexSubject.agentSession, false)
assert.equal('hookToken' in codexSubject.agentSession, false)
assert.deepEqual(codex.terminalHandshake, {
  run: { runId: codex.run.runId },
  operationId: codex.terminalHandshake?.operationId,
  inputByteRange: { startByte: 0, endByte: 5 },
  acknowledged: true
})
assert.ok(codex.terminalHandshake.operationId)
const codexAttachment = await codexFirst.reattachAgent(codex.agentSessionId, 0)
const codexSharedReplay = await codexFirst.readRunReplay(codex.run, 0)
assert.equal(codexSharedReplay.run.kind, 'agent')
assert.equal(codexSharedReplay.run.agentSessionId, codex.agentSessionId)
await waitFor('Codex native Hook identity', () => (
  codexFirst.agentSession(codex.agentSessionId).nativeHandle?.kind === 'provider' &&
  codexFirstEvents.some((event) => (
    event.type === 'agent-status' && event.agentSessionId === codex.agentSessionId && event.state === 'waiting'
  ))
))
const initialInteraction = codexFirst.agentSession(codex.agentSessionId).pendingInteraction?.request
assert.equal(initialInteraction?.kind, 'permission')
assert.equal(codexFirstEvents.some((event) => (
  event.type === 'interaction' && event.request.id === initialInteraction.id
)), true)
await assert.rejects(
  codexFirst.submitAgentPrompt({
    agentSessionId: codex.agentSessionId,
    operationId: 'packed-prompt-while-interaction-pending',
    prompt: 'must-not-bypass-permission'
  }),
  (error) => error?.code === 'AGENT_INTERACTION_PENDING'
)
await assert.rejects(
  codexFirst.writeAgent(codex.agentSessionId, '1'),
  (error) => error?.code === 'AGENT_INTERACTION_PENDING'
)
await codexFirst.respondAgentInteraction({
  agentSessionId: codex.agentSessionId,
  expectedRun: codex.run,
  response: {
    kind: 'permission',
    requestId: initialInteraction.id,
    decision: { outcome: 'selected', optionId: 'allow-once' }
  }
})
await waitFor('Codex permission response settlement', () => (
  codexFirst.agentSession(codex.agentSessionId).pendingInteraction === undefined &&
  output(codexFirstEvents, codex.run.runId).includes('codex-permission-allowed')
))
const initialReadiness = await waitFor('Codex ready prompt epoch', () => {
  const readiness = codexFirst.agentSession(codex.agentSessionId).terminalPromptReadiness
  return readiness?.readyThroughByte === undefined ? null : readiness
})
assert.equal(initialReadiness.source, 'native-stop')
assert.equal(initialReadiness.readyThroughByte, initialReadiness.outputCursorBytes)
const initialTimeline = await codexFirst.sessionTimeline(codex.agentSessionId)
const initialTimelineEvents = codexFirstEvents.filter((event) => (
  event.type === 'agent-timeline' && event.agentSessionId === codex.agentSessionId
))
assert.ok(initialTimeline.revision > 0)
assert.equal(initialTimeline.agentSessionId, codex.agentSessionId)
assert.equal(initialTimelineEvents.length, initialTimeline.revision)
assert.deepEqual(
  initialTimelineEvents.map((event) => event.revision).sort((left, right) => left - right),
  Array.from({ length: initialTimeline.revision }, (_value, index) => index + 1)
)
assert.equal(initialTimeline.items.some((item) => (
  item.kind === 'user_message' && item.source === 'user' && item.content === 'first'
)), true)
assert.equal(initialTimeline.items.some((item) => (
  item.kind === 'permission' && item.source === 'native-hook' &&
  item.toolName === 'request_user_input'
)), true)
for (const publication of await Promise.all(codexTimelinePublicationSnapshots)) {
  assert.equal(publication.snapshot.agentSessionId, publication.event.agentSessionId)
  assert.ok(publication.snapshot.revision >= publication.event.revision)
}
const acknowledgedThroughByte = (await codexFirst.statusAgent(codex.agentSessionId)).run.latestOutputBytes
assert.ok(acknowledgedThroughByte > 0)
await codexFirst.acknowledgeAgentOutput(codex.agentSessionId, acknowledgedThroughByte)
await codexFirst.acknowledgeAgentOutput(codex.agentSessionId, acknowledgedThroughByte - 1)
assert.equal(codexFirst.agentSession(codex.agentSessionId).outputCursorBytes, acknowledgedThroughByte)
assert.equal(codexFirst.resolveAgentSession({ kind: 'run', run: codex.run }).agentSessionId, codex.agentSessionId)
assert.equal(codexFirst.resolveAgentSession({
  kind: 'provider-native',
  providerId: 'codex',
  sessionId: 'native-codex-semantic-1'
}).agentSessionId, codex.agentSessionId)
assert.equal(codexFirstEvents.some((event) => (
  event.type === 'agent-status' && event.agentSessionId === codex.agentSessionId && event.state === 'waiting'
)), true)
assert.equal((await codexFirst.statusAgent(codex.agentSessionId)).run.state, 'running')
const codexPid = (await codexFirst.statusAgent(codex.agentSessionId)).run.pid
assert.ok(codexPid)
await codexFirst.dispose()
codexFirst = null

const cliStatus = JSON.parse((await cli(['inspect', '--session', codex.agentSessionId])).stdout)
assert.equal(cliStatus.schemaVersion, AGENTMUX_CONTROL_SCHEMA_VERSION)
assert.equal(cliStatus.ok, true)
assert.equal(typeof cliStatus.requestId, 'string')
assert.equal(cliStatus.operation, 'inspect.session')
assert.equal(cliStatus.result.session.agentSessionId, codex.agentSessionId)
assert.equal(cliStatus.result.session.run.runId, codex.run.runId)
const cliList = JSON.parse((await cli(['list', 'sessions'])).stdout)
assert.equal(cliList.operation, 'list.sessions')
assert.equal(cliList.result.sessions.length, 1)
assert.equal(cliList.result.sessions[0].session.agentSessionId, codex.agentSessionId)
for (const args of [
  ['--session', codex.agentSessionId],
  ['--provider-native', 'native-codex-semantic-1', '--provider', 'codex'],
  ['--run', codex.run.runId]
]) {
  const resolved = JSON.parse((await cli(['inspect', ...args])).stdout)
  assert.equal(resolved.operation, 'inspect.session')
  assert.equal(resolved.result.session.agentSessionId, codex.agentSessionId)
}
const controlRequests = []
const agentRegion = {
  tabId: 'packed-agent-tab',
  regionId: 'packed-agent-region',
  kind: 'agent',
  agentSessionId: codex.agentSessionId,
  providerId: 'codex',
  executorId: 'codex',
  workspaceId: 'packed-workspace'
}
const terminalRegion = {
  tabId: 'packed-agent-tab',
  regionId: 'packed-terminal-region',
  kind: 'terminal',
  runId: 'packed-terminal-run',
  workspaceId: 'packed-workspace'
}
// 只有一格、也只有一张 Tab 时的邻居：四个方向都到边。
const soleRegionNeighbors = {
  left: { kind: 'none' }, right: { kind: 'none' }, up: { kind: 'none' }, down: { kind: 'none' }
}
const controlServer = new AgentMuxControlServer({
  async execute(request) {
    controlRequests.push(request)
    if (request.operation === 'inspect.tab') {
      return {
        operation: request.operation,
        tab: {
          tabId: agentRegion.tabId,
          workspaceId: agentRegion.workspaceId,
          regions: [{ ...agentRegion, bounds: { x: 0, y: 0, width: 1, height: 1 }, neighbors: soleRegionNeighbors }]
        }
      }
    }
    if (request.operation === 'focus') {
      return {
        operation: request.operation,
        tabId: agentRegion.tabId,
        ...(request.target.kind === 'region' ? { regionId: request.target.regionId } : {})
      }
    }
    if (request.operation === 'open.agent') {
      return {
        operation: request.operation,
        region: {
          ...agentRegion,
          regionId: request.content.kind === 'agent-session' ? 'packed-opened-region' : 'packed-launched-region',
          agentSessionId: request.content.kind === 'agent-session' ? request.content.agentSessionId : 'packed-launched-session'
        }
      }
    }
    if (request.operation === 'open.terminal') {
      return {
        operation: request.operation,
        region: { ...terminalRegion, runId: 'packed-created-terminal' }
      }
    }
    if (request.operation === 'open.browser') {
      return {
        operation: request.operation,
        region: {
          tabId: agentRegion.tabId,
          regionId: 'packed-browser-region',
          workspaceId: agentRegion.workspaceId,
          kind: 'browser',
          browserId: 'packed-browser'
        }
      }
    }
    if (request.operation === 'arrange') {
      return {
        operation: request.operation,
        tab: {
          tabId: agentRegion.tabId,
          workspaceId: agentRegion.workspaceId,
          regions: [{ ...agentRegion, bounds: { x: 0, y: 0, width: 1, height: 1 }, neighbors: soleRegionNeighbors }]
        }
      }
    }
    if (request.operation === 'list.agents') {
      return { operation: request.operation, agents: [{ executorId: 'codex', label: 'Codex', providerId: 'codex', available: true }] }
    }
    const targetId = request.target.kind === 'self'
      ? request.caller.agentSessionId
      : request.target.agentSessionId
    const controlClient = await connectLocalAgentMux()
    try {
      if (request.operation === 'send') {
        if (request.target.kind === 'tab') {
          throw Object.assign(new Error('Tab contains multiple Agent Sessions.'), {
            code: 'MESSAGE_TARGET_NOT_UNIQUE',
            candidates: [
              { agentSessionId: 'packed-writer', regionIds: ['packed-writer-region'] },
              { agentSessionId: 'packed-reviewer', regionIds: ['packed-reviewer-region'] }
            ]
          })
        }
        await controlClient.submitAgentPrompt({ agentSessionId: targetId, operationId: request.requestId, prompt: request.text })
        return { operation: request.operation, agentSessionId: targetId }
      }
      if (request.operation === 'interrupt') {
        await controlClient.signalAgent(targetId, 'SIGINT')
        return { operation: request.operation, agentSessionId: targetId }
      }
      if (request.operation === 'resume') {
        const session = await controlClient.resumeAgent({ agentSessionId: targetId, operationId: request.requestId, prompt: request.text, commandOverride: fakeCodex })
        return { operation: request.operation, agentSessionId: targetId, runId: session.run.runId }
      }
      if (request.operation === 'stop') {
        const session = controlClient.agentSession(targetId)
        await controlClient.stopAgent(targetId, session.run)
        return { operation: request.operation, agentSessionId: targetId }
      }
    } finally {
      await controlClient.dispose()
    }
    throw Object.assign(new Error('Unsupported packed Control request.'), { code: 'CONTROL_OPERATION_UNAVAILABLE' })
  }
})
await controlServer.start()
const managedEnv = { AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: codex.agentSessionId }
const cliAgents = JSON.parse((await cli(['list', 'agents'])).stdout)
assert.equal(cliAgents.operation, 'list.agents')
assert.equal(cliAgents.result.agents[0].executorId, 'codex')
const cliContext = JSON.parse((await cli(['inspect', '--tab', 'self'], managedEnv)).stdout)
assert.equal(cliContext.operation, 'inspect.tab')
assert.equal(cliContext.result.tab.regions[0].regionId, agentRegion.regionId)
const launchedRegion = JSON.parse((await cli([
  'open', 'agent', '--agent', 'codex', '--prompt', '--help', '--right-of', 'self'
], managedEnv)).stdout)
assert.equal(launchedRegion.operation, 'open.agent')
assert.equal(launchedRegion.result.region.regionId, 'packed-launched-region')
const openedRegion = JSON.parse((await cli([
  'open', 'agent', '--session', codex.agentSessionId, '--new-tab-after', agentRegion.tabId
], managedEnv)).stdout)
assert.equal(openedRegion.operation, 'open.agent')
assert.equal(openedRegion.result.region.regionId, 'packed-opened-region')
const openedTerminal = JSON.parse((await cli([
  'open', 'terminal', '--command', 'printf packed', '--below', agentRegion.regionId
])).stdout)
assert.equal(openedTerminal.operation, 'open.terminal')
assert.equal(openedTerminal.result.region.runId, 'packed-created-terminal')
const openedBrowser = JSON.parse((await cli([
  'open', 'browser', '--url', 'http://localhost:5173', '--new-tab-after', agentRegion.tabId
])).stdout)
assert.equal(openedBrowser.operation, 'open.browser')
assert.equal(openedBrowser.result.region.browserId, 'packed-browser')
const arranged = JSON.parse((await cli([
  'arrange', `--tab=${agentRegion.tabId}`, '--preset', 'columns-3'
])).stdout)
assert.equal(arranged.operation, 'arrange')
assert.equal(arranged.result.tab.tabId, agentRegion.tabId)
const focusedRegion = JSON.parse((await cli([
  'focus', '--region', 'packed-terminal-region'
])).stdout)
assert.equal(focusedRegion.operation, 'focus')
assert.equal(focusedRegion.result.regionId, terminalRegion.regionId)
assert.deepEqual(controlRequests.map((request) => request.operation), [
  'list.agents', 'inspect.tab', 'open.agent', 'open.agent', 'open.terminal', 'open.browser', 'arrange', 'focus'
])
assert.equal(controlRequests[2].content.executorId, 'codex')
assert.equal(controlRequests[2].content.prompt, '--help')
await assert.rejects(
  cli(['send', `--to-tab=${agentRegion.tabId}`, '--text', 'review']),
  (error) => {
    const receipt = JSON.parse(error.stderr)
    assert.equal(receipt.schemaVersion, AGENTMUX_CONTROL_SCHEMA_VERSION)
    assert.equal(receipt.ok, false)
    assert.equal(typeof receipt.requestId, 'string')
    assert.equal(receipt.operation, 'send')
    assert.equal(receipt.error.code, 'MESSAGE_TARGET_NOT_UNIQUE')
    assert.deepEqual(receipt.error.candidates, [
      { agentSessionId: 'packed-writer', regionIds: ['packed-writer-region'] },
      { agentSessionId: 'packed-reviewer', regionIds: ['packed-reviewer-region'] }
    ])
    return true
  }
)
const utf8Request = {
  schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
  requestId: 'packed-继续',
  operation: 'inspect.tab',
  target: { kind: 'tab', tabId: agentRegion.tabId }
}
const utf8Bytes = Buffer.from(`${JSON.stringify(utf8Request)}\n`, 'utf8')
const utf8Start = utf8Bytes.indexOf(Buffer.from('继续', 'utf8'))
assert.ok(utf8Start >= 0)
const utf8Receipt = await rawControlReceipt(controlServer.path, utf8Request, utf8Start + 1)
assert.equal(utf8Receipt.requestId, utf8Request.requestId)
assert.equal(utf8Receipt.result.tab.tabId, agentRegion.tabId)
const cliAttachment = JSON.parse((await cli([
  'output', '--session', codex.agentSessionId, '--after-byte', '0'
])).stdout)
assert.equal(cliAttachment.result.session.agentSessionId, codex.agentSessionId)
const followReader = spawnOwned(agentmuxCli, [
  'output', '--session', codex.agentSessionId, '--after-byte', '0', '--follow'
], { stdio: ['ignore', 'pipe', 'pipe'] })
const followAttached = await firstJsonLine(followReader, 'session output follower')
assert.deepEqual(
  {
    schemaVersion: followAttached.schemaVersion,
    operation: followAttached.operation,
    event: followAttached.event,
    agentSessionId: followAttached.result.session.agentSessionId
  },
  {
    schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    operation: 'output',
    event: 'attached',
    agentSessionId: codex.agentSessionId
  }
)
followReader.kill('SIGINT')
await once(followReader, 'exit')
assert.equal(
  JSON.parse((await cli(['inspect', '--session', codex.agentSessionId])).stdout)
    .result.session.run.runId,
  codex.run.runId
)
await cli(['send', '--to-session', codex.agentSessionId, '--text', 'continue\nwith details'])
await cli(['interrupt', '--session', codex.agentSessionId])

const codexSecond = await connectLocalAgentMux()
const codexSecondEvents = []
codexSecond.onEvent((event) => codexSecondEvents.push(event))
const codexReconnected = await codexSecond.statusAgent(codex.agentSessionId)
assert.equal(codexReconnected.run.runId, codex.run.runId)
assert.equal(codexReconnected.run.pid, codexPid)
assert.equal(codexSecond.agentSessions().length, 1)
const codexReplay = await codexSecond.reattachAgent(codex.agentSessionId, 0)
const replayText = codexAttachment.attachment.replay.map((event) => event.data).join('') +
  codexReplay.attachment.replay.map((event) => event.data).join('')
const liveText = () => codexSecondEvents.flatMap((event) => (
  event.type === 'terminal-output' ? [event.data] : []
)).join('')
const normalizeOutput = (text) => text.replaceAll('\r\n', '\n')
const currentCodexOutput = async () => {
  const snapshot = await codexSecond.readRunReplay(codex.run, 0)
  return normalizeOutput(snapshot.replay.map((event) => event.data).join('') + liveText())
}
await waitFor('Codex Provider submit sequence', async () => (
  (await currentCodexOutput()).includes('codex-submit:continue\nwith details:accepted')
))
const codexReplayText = normalizeOutput(`${replayText}${await currentCodexOutput()}`)
assert.equal(codexReplayText.includes('codex-ready:first'), true)
assert.equal(codexReplayText.includes('codex-submit:continue\nwith details:accepted'), true)
assert.equal(
  codexReplayText.includes(`codex-composer-rendered:${Buffer.byteLength('continue\nwith details')}`),
  true
)
assert.equal(codexReplayText.includes('codex-composer-near-miss'), true)
assert.equal(codexReplayText.includes('codex-historical-prompt-match'), true)
assert.equal(codexReplayText.includes('codex-ignored-early-enter'), false)
assert.equal(codexReplayText.includes('codex-interrupt'), true)
assert.equal(codexReplayText.includes('\u001b[?7u'), false)
assert.equal(codexReplayText.includes('\u001b[13u'), false)
const timelineAfterSubmittedPrompt = await codexSecond.sessionTimeline(codex.agentSessionId)
assert.ok(timelineAfterSubmittedPrompt.revision > initialTimeline.revision)
assert.equal(timelineAfterSubmittedPrompt.items.some((item) => (
  item.kind === 'user_message' && item.source === 'user' && item.content === 'continue\nwith details'
)), true)
const handshakeQueryIndex = codexReplayText.indexOf('\u001b[?u')
const handshakeAckIndex = codexReplayText.indexOf('codex-handshake:kitty-flags-0')
const initialPromptIndex = codexReplayText.indexOf('codex-ready:first')
const submittedPromptIndex = codexReplayText.indexOf('codex-submit:continue\nwith details:accepted')
assert.ok(handshakeQueryIndex >= 0)
assert.ok(handshakeAckIndex > handshakeQueryIndex)
assert.ok(initialPromptIndex > handshakeAckIndex)
assert.ok(submittedPromptIndex > handshakeAckIndex)
try {
  await waitFor('next ready prompt epoch', () => {
    const readiness = codexSecond.agentSession(codex.agentSessionId).terminalPromptReadiness
    return readiness?.id !== initialReadiness.id && readiness?.readyThroughByte !== undefined
  })
} catch (error) {
  const session = codexSecond.agentSession(codex.agentSessionId)
  const agentErrors = codexSecondEvents.filter((event) => event.type === 'agent-error')
  const debugAttachment = JSON.parse((await cli([
    'output', '--session', codex.agentSessionId, '--after-byte', '0'
  ])).stdout)
  throw new Error(`${error.message}\n${JSON.stringify({
    terminalPromptReadiness: session.terminalPromptReadiness,
    terminalPromptSubmission: session.terminalPromptSubmission,
    agentErrors,
    outputTail: debugAttachment.result.replay.map((event) => event.data).join('').slice(-1_500)
  }, null, 2)}`)
}
const oversizedPrompt = 'x'.repeat(64 * 1024 + 1)
await assert.rejects(
  codexSecond.submitAgentPrompt({
    agentSessionId: codex.agentSessionId,
    operationId: 'packed-codex-oversized-prompt',
    prompt: oversizedPrompt
  }),
  (error) => error?.code === 'INVALID_AGENT_PROMPT'
)
await waitFor('ready prompt epoch after long input', () => {
  const readiness = codexSecond.agentSession(codex.agentSessionId).terminalPromptReadiness
  return readiness?.readyThroughByte === undefined ? null : readiness
})
await codexSecond.submitAgentPrompt({
  agentSessionId: codex.agentSessionId,
  operationId: 'packed-codex-exit',
  prompt: 'exit'
})
await waitFor('Codex Run exit', async () => (
  (await codexSecond.statusAgent(codex.agentSessionId)).run.state === 'exited'
))
await assert.rejects(
  codexSecond.submitAgentPrompt({
    agentSessionId: codex.agentSessionId,
    operationId: 'packed-codex-after-exit',
    prompt: 'must-not-reach-exited-run'
  }),
  (error) => error?.code === 'STALE_AGENT_SESSION'
)
await codexSecond.dispose()

const continuityClient = await connectLocalAgentMux()
const continuityContender = await connectLocalAgentMux()
const continuityTimelineBefore = await continuityClient.sessionTimeline(codex.agentSessionId)
const continuityResults = await Promise.all([
  continuityContender.ensureAgentContinuity({
    agentSessionId: codex.agentSessionId,
    expectedRun: codex.run,
    operationId: 'packed-continuity-owner',
    commandOverride: fakeCodex
  }),
  continuityClient.ensureAgentContinuity({
    agentSessionId: codex.agentSessionId,
    expectedRun: codex.run,
    operationId: 'packed-continuity-contender',
    commandOverride: fakeCodex
  })
])
assert.deepEqual(
  continuityResults.map((result) => result.kind).sort(),
  ['conflict', 'resumed']
)
const continuityConflict = continuityResults.find((result) => result.kind === 'conflict')
assert.equal(continuityConflict?.evidence.kind, 'hook-ingress-owner')
const continuityResumed = continuityResults.find((result) => result.kind === 'resumed')
assert.ok(continuityResumed)
assert.equal(continuityResumed.session.agentSessionId, codex.agentSessionId)
assert.notEqual(continuityResumed.run.runId, codex.run.runId)
const continuityRuns = (await continuityClient.listRuns()).filter((run) => (
  run.kind === 'agent' && run.agentSessionId === codex.agentSessionId
))
assert.deepEqual(continuityRuns.map((run) => run.runId), [continuityResumed.run.runId])
const disconnectedContinuity = await connectLocalAgentMux()
disconnectedContinuity.disconnect()
await assert.rejects(
  disconnectedContinuity.ensureAgentContinuity({
    agentSessionId: codex.agentSessionId,
    expectedRun: continuityResumed.run,
    operationId: 'packed-continuity-transport-error',
    commandOverride: fakeCodex
  }),
  (error) => error?.code === 'CTXMUX_DISCONNECTED'
)
assert.deepEqual(
  (await continuityClient.listRuns()).filter((run) => (
    run.kind === 'agent' && run.agentSessionId === codex.agentSessionId
  )).map((run) => run.runId),
  [continuityResumed.run.runId]
)
await disconnectedContinuity.dispose()
// 监听要装在 reattach **之前**：两者之间抵达的实时事件没有别处可收。
const continuityEvents = []
continuityClient.onEvent((event) => continuityEvents.push(event))
await reattachAgentWithReplay(continuityClient, codex.agentSessionId, continuityEvents)
await waitFor('promptless native continuity', () => (
  output(continuityEvents, continuityResumed.run.runId).includes('codex-ready:')
))
await waitFor('promptless continuity readiness', () => (
  continuityClient.agentSession(codex.agentSessionId).terminalPromptReadiness?.source === 'native-stop' &&
  continuityClient.agentSession(codex.agentSessionId).terminalPromptReadiness?.readyThroughByte !== undefined
))
const continuityTimelineAfter = await continuityClient.sessionTimeline(codex.agentSessionId)
assert.deepEqual(
  continuityTimelineAfter.items.filter((item) => item.kind === 'user_message').map((item) => item.content),
  continuityTimelineBefore.items.filter((item) => item.kind === 'user_message').map((item) => item.content)
)
await continuityClient.submitAgentPrompt({
  agentSessionId: codex.agentSessionId,
  operationId: 'packed-continuity-exit',
  prompt: 'exit'
})
await waitFor('promptless continuity Run exit', async () => (
  (await continuityClient.statusAgent(codex.agentSessionId)).run.state === 'exited'
))
await continuityClient.dispose()
await continuityContender.dispose()

const resumeRollbackDelegate = new AgentMuxFileAgentSessionStore()
let failedResumeReservation = null
let failedResumeRetiredRuns = []
const resumeRollbackStore = {
  load: async () => await resumeRollbackDelegate.load(),
  loadRetiredRuns: async () => await resumeRollbackDelegate.loadRetiredRuns(),
  loadRetiredAgentSessions: async () => await resumeRollbackDelegate.loadRetiredAgentSessions(),
  compareAndSwap: async (...args) => await resumeRollbackDelegate.compareAndSwap(...args),
  reserveLifecycle: async (reservation) => await resumeRollbackDelegate.reserveLifecycle(reservation),
  claimStaleLifecycles: async (claim) => await resumeRollbackDelegate.claimStaleLifecycles(claim),
  retireRuns: async (runs) => await resumeRollbackDelegate.retireRuns(runs),
  loadTimeline: async (agentSessionId) => await resumeRollbackDelegate.loadTimeline(agentSessionId),
  applyTimelineMutation: async (...args) => await resumeRollbackDelegate.applyTimelineMutation(...args),
  async commitLifecycle(reservation, next) {
    if (reservation.kind === 'resume') throw new Error('packed resume commit failed')
    await resumeRollbackDelegate.commitLifecycle(reservation, next)
  },
  async releaseLifecycle(reservation, retiredRuns) {
    if (reservation.kind === 'resume') {
      failedResumeReservation = reservation
      failedResumeRetiredRuns = retiredRuns ?? []
      throw new Error('packed resume rollback receipt failed')
    }
    await resumeRollbackDelegate.releaseLifecycle(reservation, retiredRuns)
  }
}
const resumeRollbackClient = await connectLocalAgentMux({ store: resumeRollbackStore })
const runsBeforeResumeRollback = new Set((await resumeRollbackClient.listRuns()).map((run) => run.runId))
let resumeRollbackError = null
try {
  await resumeRollbackClient.ensureAgentContinuity({
    agentSessionId: codex.agentSessionId,
    expectedRun: continuityResumed.run,
    operationId: 'packed-continuity-resume-commit-failure',
    commandOverride: fakeCodex
  })
} catch (error) {
  resumeRollbackError = error
}
assert.ok(resumeRollbackError instanceof AggregateError)
assert.ok(resumeRollbackError.errors.some((error) => `${error}`.includes('packed resume commit failed')))
assert.ok(resumeRollbackError.errors.some((error) => `${error}`.includes('packed resume rollback receipt failed')))
const rollbackRun = await waitFor('resume rollback Run stopped', async () => {
  const candidates = (await resumeRollbackClient.listRuns()).filter((run) => !runsBeforeResumeRollback.has(run.runId))
  if (candidates.length === 1 && candidates[0].state !== 'running') return candidates[0]
  return null
})
assert.ok(rollbackRun)
assert.equal(
  resumeRollbackClient.agentSession(codex.agentSessionId).run.runId,
  continuityResumed.run.runId
)
assert.ok(failedResumeReservation)
await resumeRollbackDelegate.releaseLifecycle(failedResumeReservation, failedResumeRetiredRuns)
await resumeRollbackClient.dispose()

const resumePrompt = 'packed native resume prompt'
const resumeResult = JSON.parse((await cli([
  'resume', '--session', codex.agentSessionId, '--text', resumePrompt
])).stdout)
const codexThird = await connectLocalAgentMux()
const resumed = codexThird.agentSession(codex.agentSessionId)
assert.equal(resumeResult.result.runId, resumed.run.runId)
assert.equal(resumed.agentSessionId, codex.agentSessionId)
assert.notEqual(resumed.run.runId, codex.run.runId)
assert.deepEqual(resumed.terminalHandshake?.inputByteRange, { startByte: 0, endByte: 5 })
assert.equal(resumed.terminalHandshake?.acknowledged, true)
assert.equal(codexThird.agentSessions().length, 1)
const codexThirdEvents = []
codexThird.onEvent((event) => codexThirdEvents.push(event))
await reattachAgentWithReplay(codexThird, resumed.agentSessionId, codexThirdEvents)
await waitFor('native resume argv prompt', () => (
  output(codexThirdEvents, resumed.run.runId).includes(`codex-ready:${resumePrompt}`)
))
await waitFor('resumed Codex Hook receipt', () => (
  codexThird.agentSession(resumed.agentSessionId).hookReceipt?.run.runId === resumed.run.runId
))
const resumedTimeline = await codexThird.sessionTimeline(resumed.agentSessionId)
assert.equal(resumedTimeline.agentSessionId, codex.agentSessionId)
assert.ok(resumedTimeline.revision > timelineAfterSubmittedPrompt.revision)
assert.equal(resumedTimeline.items.some((item) => (
  item.kind === 'user_message' && item.source === 'user' && item.content === resumePrompt
)), true)
assert.equal(resumedTimeline.items.some((item) => item.content === 'continue\nwith details'), true)
assert.equal(resumedTimeline.items.some((item) => item.id.startsWith(`${resumed.run.runId}:`)), true)
await waitFor('resumed Codex ready prompt epoch', () => (
  codexThird.agentSession(resumed.agentSessionId).terminalPromptReadiness?.readyThroughByte !== undefined
))
assert.throws(
  () => codexThird.resolveAgentSession({ kind: 'run', run: codex.run }),
  (error) => error?.code === 'STALE_AGENT_SESSION_BINDING'
)
const reboundBeforeStaleResize = (await codexThird.statusAgent(resumed.agentSessionId)).run
assert.equal(reboundBeforeStaleResize.runId, resumed.run.runId)
await assert.rejects(
  codexThird.resizeAgent(resumed.agentSessionId, codex.run, 111, 43),
  (error) => error?.code === 'STALE_AGENT_SESSION'
)
const reboundAfterStaleResize = (await codexThird.statusAgent(resumed.agentSessionId)).run
assert.deepEqual(
  {
    runId: reboundAfterStaleResize.runId,
    cols: reboundAfterStaleResize.cols,
    rows: reboundAfterStaleResize.rows
  },
  {
    runId: reboundBeforeStaleResize.runId,
    cols: reboundBeforeStaleResize.cols,
    rows: reboundBeforeStaleResize.rows
  }
)
assert.deepEqual(
  await codexThird.resizeAgent(resumed.agentSessionId, resumed.run, 109, 41),
  { runId: resumed.run.runId, cols: 109, rows: 41 }
)
await assert.rejects(
  codexThird.stopAgent(resumed.agentSessionId, codex.run),
  (error) => error?.code === 'STALE_AGENT_SESSION'
)
const reboundAfterStaleStop = (await codexThird.statusAgent(resumed.agentSessionId)).run
assert.deepEqual(
  {
    runId: reboundAfterStaleStop.runId,
    state: reboundAfterStaleStop.state
  },
  { runId: resumed.run.runId, state: 'running' }
)
await assert.rejects(
  cli(['inspect', '--run', codex.run.runId]),
  (error) => error?.stderr?.includes('STALE_AGENT_SESSION_BINDING')
)
await codexThird.submitAgentPrompt({
  agentSessionId: resumed.agentSessionId,
  operationId: 'packed-codex-resumed-exit',
  prompt: 'exit'
})
await waitFor('resumed Codex Run natural exit', async () => (
  (await codexThird.statusAgent(resumed.agentSessionId)).run.state === 'exited'
))
await codexThird.dispose()
await cli(['stop', '--session', resumed.agentSessionId])
const codexStopped = await connectLocalAgentMux()
assert.deepEqual(codexStopped.agentSessions(), [])
const retiredContinuity = await codexStopped.ensureAgentContinuity({
  agentSessionId: resumed.agentSessionId,
  expectedRun: resumed.run,
  operationId: 'packed-continuity-retired'
})
assert.deepEqual({
  ...retiredContinuity,
  evidence: { kind: retiredContinuity.evidence.kind }
}, {
  kind: 'retired',
  agentSessionId: resumed.agentSessionId,
  previousRun: resumed.run,
  evidence: { kind: 'user-retired' }
})
assert.equal(typeof retiredContinuity.evidence.observedAt, 'number')
await codexStopped.dispose()

const literalPromptClient = await connectLocalAgentMux()
const literalPromptEvents = []
literalPromptClient.onEvent((event) => literalPromptEvents.push(event))
const literalPromptAgent = await literalPromptClient.createAgent({
  agentSessionId: 'codex-literal-option-prompt',
  createOperationId: 'packed-codex-literal-option-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex
})
await reattachAgentWithReplay(literalPromptClient, literalPromptAgent.agentSessionId, literalPromptEvents)
await waitFor('literal prompt Agent ready epoch', () => (
  literalPromptClient.agentSession(literalPromptAgent.agentSessionId)
    .terminalPromptReadiness?.source === 'native-stop' &&
  literalPromptClient.agentSession(literalPromptAgent.agentSessionId)
    .terminalPromptReadiness?.readyThroughByte !== undefined
))
await cli(['send', '--to-session', literalPromptAgent.agentSessionId, '--text', '--help'])
await waitFor('literal option-like prompt submitted', () => (
  output(literalPromptEvents, literalPromptAgent.run.runId).includes('codex-submit:--help:accepted')
))
await literalPromptClient.dispose()
const literalPromptCleanup = await connectLocalAgentMux()
await literalPromptCleanup.stopAgent(literalPromptAgent.agentSessionId, literalPromptAgent.run)
await literalPromptCleanup.dispose()

const noStopClient = await connectLocalAgentMux()
const noStopEvents = []
noStopClient.onEvent((event) => noStopEvents.push(event))
const noStop = await noStopClient.createAgent({
  agentSessionId: 'codex-no-stop',
  createOperationId: 'packed-codex-no-stop-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'no-stop' }
})
await reattachAgentWithReplay(noStopClient, noStop.agentSessionId, noStopEvents)
const pendingInitialReadiness = noStopClient.agentSession(noStop.agentSessionId)
  .terminalPromptReadiness
assert.equal(pendingInitialReadiness?.source, 'initial-composer')
assert.equal(pendingInitialReadiness?.readyThroughByte, undefined)
await waitFor('fake Codex waiting before initial composer', () => (
  output(noStopEvents, noStop.run.runId).includes('codex-controlled-ready-pending')
))
await assert.rejects(
  noStopClient.submitAgentPrompt({
    agentSessionId: noStop.agentSessionId,
    operationId: 'packed-no-stop-too-early',
    prompt: 'must-not-reach-pty-before-composer'
  }),
  (error) => (
    error?.code === 'AGENT_PROMPT_NOT_READY' &&
    /runId=\S+/.test(error?.detail ?? '') &&
    error?.detail?.includes('readinessSource=initial-composer') &&
    error?.detail?.includes('reason=observation-pending') &&
    !error?.detail?.includes('must-not-reach-pty-before-composer')
  )
)
assert.equal((await noStopClient.sessionTimeline(noStop.agentSessionId)).items.some((item) => (
  item.kind === 'user_message' && item.content === 'must-not-reach-pty-before-composer'
)), false)
assert.equal((await noStopClient.statusAgent(noStop.agentSessionId)).run.acceptedInputBytes, 5)
assert.equal(output(noStopEvents, noStop.run.runId).includes('codex-dropped-pre-ready-payload'), false)
await noStopClient.dispose()

const noStopReconnected = await connectLocalAgentMux()
const noStopReconnectedEvents = []
noStopReconnected.onEvent((event) => noStopReconnectedEvents.push(event))
await noStopReconnected.reattachAgent(noStop.agentSessionId, 0)
assert.equal(
  noStopReconnected.agentSession(noStop.agentSessionId).terminalPromptReadiness?.readyThroughByte,
  undefined
)
await noStopReconnected.writeAgent(noStop.agentSessionId, '\u001d')
const readyInitialReadiness = await waitFor('post-handshake empty initial composer', () => {
  const readiness = noStopReconnected.agentSession(noStop.agentSessionId).terminalPromptReadiness
  return readiness?.readyThroughByte === undefined ? null : readiness
})
assert.equal(readyInitialReadiness.source, 'initial-composer')
assert.ok(readyInitialReadiness.readyThroughByte > readyInitialReadiness.outputCursorBytes)
await noStopReconnected.submitAgentPrompt({
  agentSessionId: noStop.agentSessionId,
  operationId: 'packed-no-stop-turn-zero',
  prompt: 'turn-zero'
})
await waitFor('Turn 0 prompt submitted without native Stop', () => (
  output(noStopReconnectedEvents, noStop.run.runId).includes('codex-submit:turn-zero:accepted')
))
await assert.rejects(
  noStopReconnected.submitAgentPrompt({
    agentSessionId: noStop.agentSessionId,
    operationId: 'packed-no-stop-second-prompt',
    prompt: 'must-not-reuse-initial-readiness'
  }),
  (error) => (
    error?.code === 'AGENT_PROMPT_READINESS_CONSUMED' &&
    /runId=\S+/.test(error?.detail ?? '') &&
    error?.detail?.includes('consumedBySubmissionId=packed-no-stop-turn-zero') &&
    !error?.detail?.includes('must-not-reuse-initial-readiness')
  )
)
await noStopReconnected.stopAgent(noStop.agentSessionId, noStop.run)
await noStopReconnected.dispose()

const handshakeRaceOwner = await connectLocalAgentMux()
const handshakeRaceEvents = []
handshakeRaceOwner.onEvent((event) => handshakeRaceEvents.push(event))
const handshakeRaceCreate = handshakeRaceOwner.createAgent({
  agentSessionId: 'codex-handshake-race',
  createOperationId: 'packed-codex-handshake-race-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: {
    AGENTMUX_FAKE_READY_MODE: 'no-stop',
    AGENTMUX_FAKE_HANDSHAKE_QUERY_DELAY_MS: '300'
  }
})
const handshakeRaceStore = new AgentMuxFileAgentSessionStore()
await waitFor('handshake race lifecycle commit', async () => (
  (await handshakeRaceStore.load()).some((session) => (
    session.agentSessionId === 'codex-handshake-race'
  ))
))
const handshakeRaceContenderPromise = connectLocalAgentMux()
const [handshakeRace, handshakeRaceContender] = await Promise.all([
  handshakeRaceCreate,
  handshakeRaceContenderPromise
])
assert.equal(handshakeRace.terminalHandshake?.acknowledged, true)
assert.deepEqual(
  handshakeRaceContender.agentSession(handshakeRace.agentSessionId).terminalHandshake,
  handshakeRaceOwner.agentSession(handshakeRace.agentSessionId).terminalHandshake
)
assert.equal((await handshakeRaceOwner.statusAgent(handshakeRace.agentSessionId)).run.acceptedInputBytes, 5)
await reattachAgentWithReplay(handshakeRaceOwner, handshakeRace.agentSessionId, handshakeRaceEvents)
await waitFor('handshake race controlled composer pending', () => (
  output(handshakeRaceEvents, handshakeRace.run.runId).includes('codex-controlled-ready-pending')
))
await handshakeRaceOwner.writeAgent(handshakeRace.agentSessionId, '\u001d')
await waitFor('handshake race observer adoption', () => (
  handshakeRaceOwner.agentSession(handshakeRace.agentSessionId)
    .terminalPromptReadiness?.readyThroughByte ?? null
))
await handshakeRaceOwner.stopAgent(handshakeRace.agentSessionId, handshakeRace.run)
await handshakeRaceContender.dispose()
await handshakeRaceOwner.dispose()

const initialAssistantClient = await connectLocalAgentMux()
const initialAssistantEvents = []
initialAssistantClient.onEvent((event) => initialAssistantEvents.push(event))
const initialAssistant = await initialAssistantClient.createAgent({
  agentSessionId: 'codex-initial-assistant-marker',
  createOperationId: 'packed-codex-initial-assistant-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'no-stop-assistant' }
})
await reattachAgentWithReplay(initialAssistantClient, initialAssistant.agentSessionId, initialAssistantEvents)
await waitFor('assistant marker without initial composer', () => (
  output(initialAssistantEvents, initialAssistant.run.runId)
    .includes('codex-assistant-marker-without-composer')
))
await new Promise((resolve) => setTimeout(resolve, 150))
assert.equal(
  initialAssistantClient.agentSession(initialAssistant.agentSessionId)
    .terminalPromptReadiness?.readyThroughByte,
  undefined
)
await assert.rejects(
  initialAssistantClient.submitAgentPrompt({
    agentSessionId: initialAssistant.agentSessionId,
    operationId: 'packed-initial-assistant-too-early',
    prompt: 'must-not-reach-pty'
  }),
  (error) => error?.code === 'AGENT_PROMPT_NOT_READY'
)
await initialAssistantClient.writeAgent(initialAssistant.agentSessionId, '\u001d')
await waitFor('real initial composer after misleading assistant marker', () => (
  initialAssistantClient.agentSession(initialAssistant.agentSessionId)
    .terminalPromptReadiness?.readyThroughByte ?? null
))
await initialAssistantClient.stopAgent(initialAssistant.agentSessionId, initialAssistant.run)
await initialAssistantClient.dispose()

const preHandshakeComposerClient = await connectLocalAgentMux()
const preHandshakeComposerEvents = []
preHandshakeComposerClient.onEvent((event) => preHandshakeComposerEvents.push(event))
const preHandshakeComposer = await preHandshakeComposerClient.createAgent({
  agentSessionId: 'codex-pre-handshake-composer',
  createOperationId: 'packed-codex-pre-handshake-composer-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'pre-handshake-composer' }
})
await reattachAgentWithReplay(preHandshakeComposerClient, preHandshakeComposer.agentSessionId, preHandshakeComposerEvents)
await waitFor('ordinary output after pre-handshake composer', () => (
  output(preHandshakeComposerEvents, preHandshakeComposer.run.runId)
    .includes('codex-post-handshake-status-only')
))
assert.equal(
  preHandshakeComposerClient.agentSession(preHandshakeComposer.agentSessionId)
    .terminalPromptReadiness?.readyThroughByte,
  undefined
)
await assert.rejects(
  preHandshakeComposerClient.submitAgentPrompt({
    agentSessionId: preHandshakeComposer.agentSessionId,
    operationId: 'packed-pre-handshake-composer-too-early',
    prompt: 'must-require-post-handshake-frame'
  }),
  (error) => error?.code === 'AGENT_PROMPT_NOT_READY'
)
await preHandshakeComposerClient.writeAgent(preHandshakeComposer.agentSessionId, '\u001d')
await waitFor('new complete composer frame after handshake boundary', () => (
  preHandshakeComposerClient.agentSession(preHandshakeComposer.agentSessionId)
    .terminalPromptReadiness?.readyThroughByte ?? null
))
await preHandshakeComposerClient.stopAgent(
  preHandshakeComposer.agentSessionId,
  preHandshakeComposer.run
)
await preHandshakeComposerClient.dispose()

const promptedNoStopClient = await connectLocalAgentMux()
const promptedNoStopEvents = []
promptedNoStopClient.onEvent((event) => promptedNoStopEvents.push(event))
const promptedNoStop = await promptedNoStopClient.createAgent({
  agentSessionId: 'codex-prompted-no-stop',
  createOperationId: 'packed-codex-prompted-no-stop-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  injectAgentMuxGuide: true,
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'no-stop' }
})
await reattachAgentWithReplay(promptedNoStopClient, promptedNoStop.agentSessionId, promptedNoStopEvents)
await waitFor('prompted Run waiting before composer', () => (
  output(promptedNoStopEvents, promptedNoStop.run.runId)
    .includes('codex-controlled-ready-pending')
))
assert.equal(
  promptedNoStopClient.agentSession(promptedNoStop.agentSessionId).terminalPromptReadiness,
  undefined
)
await promptedNoStopClient.writeAgent(promptedNoStop.agentSessionId, '\u001d')
await waitFor('prompted Run empty composer', () => (
  output(promptedNoStopEvents, promptedNoStop.run.runId).includes('codex-composer-ready-frame')
))
await assert.rejects(
  promptedNoStopClient.submitAgentPrompt({
    agentSessionId: promptedNoStop.agentSessionId,
    operationId: 'packed-prompted-no-stop-submit',
    prompt: 'must-wait-for-native-stop'
  }),
  (error) => error?.code === 'AGENT_PROMPT_NOT_READY'
)
assert.equal(
  promptedNoStopClient.agentSession(promptedNoStop.agentSessionId).terminalPromptReadiness,
  undefined
)
await promptedNoStopClient.stopAgent(promptedNoStop.agentSessionId, promptedNoStop.run)
await promptedNoStopClient.dispose()

const argsPromptClient = await connectLocalAgentMux()
const argsPromptEvents = []
argsPromptClient.onEvent((event) => argsPromptEvents.push(event))
const argsPrompt = await argsPromptClient.createAgent({
  agentSessionId: 'codex-args-prompt-no-stop',
  createOperationId: 'packed-codex-args-prompt-no-stop-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  args: ['already-delivered-through-provider-args'],
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'no-stop' }
})
await reattachAgentWithReplay(argsPromptClient, argsPrompt.agentSessionId, argsPromptEvents)
await waitFor('args-prompt Run waiting before composer', () => (
  output(argsPromptEvents, argsPrompt.run.runId).includes('codex-controlled-ready-pending')
))
assert.equal(
  argsPromptClient.agentSession(argsPrompt.agentSessionId).terminalPromptReadiness,
  undefined
)
await argsPromptClient.writeAgent(argsPrompt.agentSessionId, '\u001d')
await waitFor('args-prompt Run empty composer', () => (
  output(argsPromptEvents, argsPrompt.run.runId).includes('codex-composer-ready-frame')
))
await assert.rejects(
  argsPromptClient.submitAgentPrompt({
    agentSessionId: argsPrompt.agentSessionId,
    operationId: 'packed-args-prompt-no-stop-submit',
    prompt: 'must-wait-for-native-stop'
  }),
  (error) => error?.code === 'AGENT_PROMPT_NOT_READY'
)
await argsPromptClient.stopAgent(argsPrompt.agentSessionId, argsPrompt.run)
await argsPromptClient.dispose()

const staleHookOwner = await connectLocalAgentMux()
const staleHookEvents = []
staleHookOwner.onEvent((event) => staleHookEvents.push(event))
const staleHookSession = await staleHookOwner.createAgent({
  agentSessionId: 'codex-stale-hook-owner',
  createOperationId: 'packed-codex-stale-hook-owner-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'before' }
})
const staleHookAttachment = await staleHookOwner.reattachAgent(
  staleHookSession.agentSessionId,
  0
)
const firstNativeReadiness = await waitFor('first native Stop readiness', () => {
  const readiness = staleHookOwner.agentSession(staleHookSession.agentSessionId)
    .terminalPromptReadiness
  return readiness?.source === 'native-stop' && readiness.readyThroughByte !== undefined
    ? readiness
    : null
})
const staleHookContender = await connectLocalAgentMux()
await staleHookContender.submitAgentPrompt({
  agentSessionId: staleHookSession.agentSessionId,
  operationId: 'packed-stale-hook-owner-submit',
  prompt: 'cross-client-hook'
})
const secondNativeReadiness = await waitFor('stale Hook owner adopts next native Stop', () => {
  const readiness = staleHookOwner.agentSession(staleHookSession.agentSessionId)
    .terminalPromptReadiness
  return (
    readiness?.source === 'native-stop' &&
    readiness.id !== firstNativeReadiness.id &&
    readiness.readyThroughByte !== undefined
  ) ? readiness : null
})
assert.notEqual(secondNativeReadiness.id, firstNativeReadiness.id)
const staleHookOutput = staleHookAttachment.attachment.replay
  .map((event) => event.data).join('') + output(staleHookEvents, staleHookSession.run.runId)
assert.equal(
  staleHookOutput.match(/codex-submit:cross-client-hook:accepted/gu)?.length ?? 0,
  1
)
assert.equal(
  staleHookOwner.agentSession(staleHookSession.agentSessionId)
    .terminalPromptSubmission?.submit.acknowledged,
  true
)
await staleHookContender.submitAgentPrompt({
  agentSessionId: staleHookSession.agentSessionId,
  operationId: 'packed-stale-hook-contender-second-submit',
  prompt: 'cross-client-hook-second'
})
const thirdNativeReadiness = await waitFor('long-lived contender observes the next Stop', () => {
  const readiness = staleHookOwner.agentSession(staleHookSession.agentSessionId)
    .terminalPromptReadiness
  return (
    readiness?.source === 'native-stop' &&
    readiness.id !== secondNativeReadiness.id &&
    readiness.readyThroughByte !== undefined
  ) ? readiness : null
})
assert.notEqual(thirdNativeReadiness.id, secondNativeReadiness.id)
const staleHookFinalOutput = staleHookAttachment.attachment.replay
  .map((event) => event.data).join('') + output(staleHookEvents, staleHookSession.run.runId)
assert.equal(
  staleHookFinalOutput.match(/codex-submit:cross-client-hook-second:accepted/gu)?.length ?? 0,
  1
)
assert.equal(
  staleHookOwner.agentSession(staleHookSession.agentSessionId)
    .terminalPromptSubmission?.submit.acknowledged,
  true
)
await staleHookContender.dispose()
await staleHookOwner.stopAgent(staleHookSession.agentSessionId, staleHookSession.run)
await staleHookOwner.dispose()

const afterCursorClient = await connectLocalAgentMux()
const afterCursorEvents = []
afterCursorClient.onEvent((event) => afterCursorEvents.push(event))
const afterCursor = await afterCursorClient.createAgent({
  agentSessionId: 'codex-frame-after-cursor',
  createOperationId: 'packed-codex-after-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'after' }
})
const afterCursorAttachment = await afterCursorClient.reattachAgent(afterCursor.agentSessionId, 0)
const afterCursorReplay = afterCursorAttachment.attachment.replay.map((event) => event.data).join('')
const pendingAfterCursor = await waitFor('native Stop boundary before composer frame', () => (
  afterCursorClient.agentSession(afterCursor.agentSessionId).terminalPromptReadiness?.source === 'native-stop'
    ? afterCursorClient.agentSession(afterCursor.agentSessionId).terminalPromptReadiness
    : null
))
assert.equal(pendingAfterCursor.source, 'native-stop')
assert.equal(pendingAfterCursor.readyThroughByte, undefined)
await assert.rejects(
  afterCursorClient.submitAgentPrompt({
    agentSessionId: afterCursor.agentSessionId,
    operationId: 'packed-after-too-early',
    prompt: 'too-early'
  }),
  (error) => error?.code === 'AGENT_PROMPT_NOT_READY'
)
await waitFor('after-cursor fake control readiness', () => (
  `${afterCursorReplay}${output(afterCursorEvents, afterCursor.run.runId)}`
    .includes('codex-controlled-ready-pending')
))
await afterCursorClient.writeAgent(afterCursor.agentSessionId, '\u001d')
const readyAfterCursor = await waitFor('composer frame after captured Stop cursor', () => {
  const readiness = afterCursorClient.agentSession(afterCursor.agentSessionId).terminalPromptReadiness
  return readiness?.readyThroughByte === undefined ? null : readiness
})
assert.ok(readyAfterCursor.readyThroughByte > readyAfterCursor.outputCursorBytes)
const afterCursorContender = await connectLocalAgentMux()
const nativeStopConcurrentResults = await Promise.allSettled([
  afterCursorClient.submitAgentPrompt({
    agentSessionId: afterCursor.agentSessionId,
    operationId: 'packed-after-exit-owner',
    prompt: 'exit'
  }),
  afterCursorContender.submitAgentPrompt({
    agentSessionId: afterCursor.agentSessionId,
    operationId: 'packed-after-exit-contender',
    prompt: 'exit'
  })
])
assert.equal(nativeStopConcurrentResults.filter((result) => result.status === 'fulfilled').length, 1)
assert.equal(
  nativeStopConcurrentResults.find((result) => result.status === 'rejected')?.reason?.code,
  'AGENT_PROMPT_READINESS_CONFLICT'
)
await waitFor('after-cursor fake Codex exit', async () => (
  (await afterCursorClient.statusAgent(afterCursor.agentSessionId)).run.state === 'exited'
))
await afterCursorContender.dispose()
await afterCursorClient.stopAgent(afterCursor.agentSessionId, afterCursor.run)
await afterCursorClient.dispose()

const assistantMarkerClient = await connectLocalAgentMux()
const assistantMarkerEvents = []
assistantMarkerClient.onEvent((event) => assistantMarkerEvents.push(event))
const assistantMarker = await assistantMarkerClient.createAgent({
  agentSessionId: 'codex-assistant-marker',
  createOperationId: 'packed-codex-assistant-marker-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'after-assistant' }
})
const assistantMarkerAttachment = await assistantMarkerClient.reattachAgent(
  assistantMarker.agentSessionId,
  0
)
const assistantMarkerReplay = assistantMarkerAttachment.attachment.replay
  .map((event) => event.data)
  .join('')
const assistantMarkerReadiness = await waitFor('Stop with assistant marker but no composer', () => (
  assistantMarkerClient.agentSession(assistantMarker.agentSessionId)
    .terminalPromptReadiness?.source === 'native-stop'
    ? assistantMarkerClient.agentSession(assistantMarker.agentSessionId).terminalPromptReadiness
    : null
))
assert.equal(assistantMarkerReadiness.source, 'native-stop')
assert.equal(assistantMarkerReadiness.readyThroughByte, undefined)
await new Promise((resolve) => setTimeout(resolve, 150))
assert.equal(
  assistantMarkerClient.agentSession(assistantMarker.agentSessionId)
    .terminalPromptReadiness?.readyThroughByte,
  undefined
)
await assert.rejects(
  assistantMarkerClient.submitAgentPrompt({
    agentSessionId: assistantMarker.agentSessionId,
    operationId: 'packed-assistant-marker-too-early',
    prompt: 'must-not-reach-pty'
  }),
  (error) => error?.code === 'AGENT_PROMPT_NOT_READY'
)
await waitFor('assistant-marker fake control readiness', () => (
  `${assistantMarkerReplay}${output(assistantMarkerEvents, assistantMarker.run.runId)}`
    .includes('codex-controlled-ready-pending')
))
await assistantMarkerClient.writeAgent(assistantMarker.agentSessionId, '\u001d')
await waitFor('real composer after misleading assistant marker', () => (
  assistantMarkerClient.agentSession(assistantMarker.agentSessionId)
    .terminalPromptReadiness?.readyThroughByte ?? null
))
await assistantMarkerClient.stopAgent(assistantMarker.agentSessionId, assistantMarker.run)
await assistantMarkerClient.dispose()

const concurrentOwner = await connectLocalAgentMux()
const concurrent = await concurrentOwner.createAgent({
  agentSessionId: 'codex-concurrent-stop',
  createOperationId: 'packed-codex-concurrent-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'no-stop' }
})
await waitFor('concurrent initial composer pending', async () => (
  (await concurrentOwner.readRunReplay(concurrent.run, 0)).replay
    .some((event) => event.data.includes('codex-controlled-ready-pending'))
))
await concurrentOwner.writeAgent(concurrent.agentSessionId, '\u001d')
await waitFor('concurrent prompt ready initial epoch', () => (
  concurrentOwner.agentSession(concurrent.agentSessionId)
    .terminalPromptReadiness?.readyThroughByte !== undefined
))
assert.equal(
  concurrentOwner.agentSession(concurrent.agentSessionId).terminalPromptReadiness?.source,
  'initial-composer'
)
const concurrentContender = await connectLocalAgentMux()
const concurrentResults = await Promise.allSettled([
  concurrentOwner.submitAgentPrompt({
    agentSessionId: concurrent.agentSessionId,
    operationId: 'packed-concurrent-owner',
    prompt: 'owner-wins-or-loses'
  }),
  concurrentContender.submitAgentPrompt({
    agentSessionId: concurrent.agentSessionId,
    operationId: 'packed-concurrent-contender',
    prompt: 'contender-wins-or-loses'
  })
])
assert.equal(concurrentResults.filter((result) => result.status === 'fulfilled').length, 1)
const concurrentFailure = concurrentResults.find((result) => result.status === 'rejected')
assert.equal(concurrentFailure?.reason?.code, 'AGENT_PROMPT_READINESS_CONFLICT')
assert.match(
  concurrentFailure?.reason?.detail ?? '',
  /expectedRunId=\S+ reason=session-cas-rejected/
)
const concurrentReplay = await concurrentOwner.reattachAgent(concurrent.agentSessionId, 0)
const concurrentOutput = concurrentReplay.attachment.replay.map((event) => event.data).join('')
assert.equal(
  (concurrentOutput.match(/codex-submit:(?:owner|contender)-wins-or-loses:accepted/gu) ?? []).length,
  1
)
await concurrentContender.dispose()
await concurrentOwner.stopAgent(concurrent.agentSessionId, concurrent.run)
await concurrentOwner.dispose()

const promptCrashWorker = spawnOwned(process.execPath, [promptCrashFixture], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AGENTMUX_FAKE_CODEX: fakeCodex }
})
const promptCrashCheckpoint = await firstJsonLine(promptCrashWorker, 'prompt crash worker')
assert.equal(promptCrashCheckpoint.type, 'prompt-payload-acknowledged-before-submit')
assert.deepEqual(promptCrashCheckpoint.payloadRange, {
  startByte: 6,
  endByte: 6 + Buffer.byteLength('crash-between-phases')
})
assert.deepEqual(promptCrashCheckpoint.submitRange, {
  startByte: 6 + Buffer.byteLength('crash-between-phases'),
  endByte: 7 + Buffer.byteLength('crash-between-phases')
})
const [promptCrashCode] = await once(promptCrashWorker, 'exit')
assert.equal(promptCrashCode, 91)

const promptRecovered = await connectLocalAgentMux()
const promptRecoveredEvents = []
promptRecovered.onEvent((event) => promptRecoveredEvents.push(event))
const promptRecoveredAttachment = await promptRecovered.reattachAgent(
  promptCrashCheckpoint.agentSessionId,
  0
)
assert.equal(
  promptRecovered.agentSession(promptCrashCheckpoint.agentSessionId)
    .terminalPromptSubmission?.readinessSource,
  'initial-composer'
)
const replacementReadiness = await waitFor('native Stop replaces crash submission readiness', () => {
  const readiness = promptRecovered.agentSession(promptCrashCheckpoint.agentSessionId)
    .terminalPromptReadiness
  return readiness?.source === 'native-stop' ? readiness : null
})
assert.equal(replacementReadiness.readyThroughByte, undefined)
await promptRecovered.submitAgentPrompt({
  agentSessionId: promptCrashCheckpoint.agentSessionId,
  operationId: promptCrashCheckpoint.operationId,
  prompt: 'crash-between-phases'
})
// 崩在 CAS 落盘之后，所以 submit 字节早在崩溃前就投给 ctxmux 了——那行 accepted 落在 replay 里，
// 重连后的事件流不会再出一次。只看新事件必然空等到超时，得和 1566 一样把 replay 一起算进来。
// 这条同时守住「不重发」：幂等重放若真的二次投递，下面 accepted 的计数就会变成 2。
await waitFor('crash-recovered prompt submit phase', () => (
  (
    promptRecoveredAttachment.attachment.replay.map((event) => event.data).join('') +
    output(promptRecoveredEvents, promptCrashCheckpoint.runId)
  ).includes('codex-submit:crash-between-phases:accepted')
))
const promptRecoveryOutput = promptRecoveredAttachment.attachment.replay
  .map((event) => event.data).join('') + output(promptRecoveredEvents, promptCrashCheckpoint.runId)
assert.equal(
  promptRecoveryOutput.match(/codex-composer-rendered:20/gu)?.length ?? 0,
  1
)
assert.equal(
  promptRecoveryOutput.match(/codex-submit:crash-between-phases:accepted/gu)?.length ?? 0,
  1
)
assert.equal(
  promptRecovered.agentSession(promptCrashCheckpoint.agentSessionId)
    .terminalPromptSubmission?.submit.acknowledged,
  true
)
await promptRecovered.stopAgent(
  promptCrashCheckpoint.agentSessionId,
  { runId: promptCrashCheckpoint.runId }
)
await promptRecovered.dispose()

const promptSubmitBeforeAckCrashWorker = spawnOwned(process.execPath, [promptCrashFixture], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    AGENTMUX_FAKE_CODEX: fakeCodex,
    AGENTMUX_PROMPT_CRASH_POINT: 'submit-before-store-ack'
  }
})
const promptSubmitBeforeAckCrashCheckpoint = await firstJsonLine(
  promptSubmitBeforeAckCrashWorker,
  'prompt submit before-ack crash worker'
)
assert.equal(
  promptSubmitBeforeAckCrashCheckpoint.type,
  'prompt-submit-applied-before-store-ack'
)
assert.deepEqual(promptSubmitBeforeAckCrashCheckpoint.submitRange, {
  startByte: 6 + Buffer.byteLength('crash-between-phases'),
  endByte: 7 + Buffer.byteLength('crash-between-phases')
})
const [promptSubmitBeforeAckCrashCode] = await once(promptSubmitBeforeAckCrashWorker, 'exit')
assert.equal(promptSubmitBeforeAckCrashCode, 93)

const promptSubmitBeforeAckRecovered = await connectLocalAgentMux()
const promptSubmitBeforeAckRecoveredEvents = []
promptSubmitBeforeAckRecovered.onEvent((event) => {
  promptSubmitBeforeAckRecoveredEvents.push(event)
})
const promptSubmitBeforeAckRecoveredAttachment = await promptSubmitBeforeAckRecovered.reattachAgent(
  promptSubmitBeforeAckCrashCheckpoint.agentSessionId,
  0
)
const promptSubmitBeforeAckSubmission = promptSubmitBeforeAckRecovered.agentSession(
  promptSubmitBeforeAckCrashCheckpoint.agentSessionId
).terminalPromptSubmission
// 崩在那唯一一次 CAS 之前，所以两个受据都还没落盘。payload 受据不再单独整写一次 CAS
// （client.ts:2776-2781 提前 return，随 submit 受据一次落盘），「payload 已 ack、submit 还没」
// 这个中间持久态已不存在——恢复端只能从 ctxmux 的 acceptedInputBytes 重推，就是下面那条。
assert.equal(promptSubmitBeforeAckSubmission?.payload.acknowledged, false)
assert.equal(promptSubmitBeforeAckSubmission?.submit.acknowledged, false)
assert.equal(
  (await promptSubmitBeforeAckRecovered.statusAgent(
    promptSubmitBeforeAckCrashCheckpoint.agentSessionId
  )).run.acceptedInputBytes,
  promptSubmitBeforeAckCrashCheckpoint.submitRange.endByte
)
await promptSubmitBeforeAckRecovered.submitAgentPrompt({
  agentSessionId: promptSubmitBeforeAckCrashCheckpoint.agentSessionId,
  operationId: promptSubmitBeforeAckCrashCheckpoint.operationId,
  prompt: 'crash-between-phases'
})
await waitFor('submit-before-ack crash output settles', () => (
  (
    promptSubmitBeforeAckRecoveredAttachment.attachment.replay
      .map((event) => event.data).join('') +
    output(promptSubmitBeforeAckRecoveredEvents, promptSubmitBeforeAckCrashCheckpoint.runId)
  ).includes('codex-submit:crash-between-phases:accepted')
))
const promptSubmitBeforeAckRecoveryOutput = promptSubmitBeforeAckRecoveredAttachment.attachment.replay
  .map((event) => event.data).join('') +
  output(promptSubmitBeforeAckRecoveredEvents, promptSubmitBeforeAckCrashCheckpoint.runId)
assert.equal(
  promptSubmitBeforeAckRecoveryOutput.match(/codex-composer-rendered:20/gu)?.length ?? 0,
  1
)
assert.equal(
  promptSubmitBeforeAckRecoveryOutput.match(/codex-submit:crash-between-phases:accepted/gu)?.length ?? 0,
  1
)
assert.equal(
  promptSubmitBeforeAckRecovered.agentSession(promptSubmitBeforeAckCrashCheckpoint.agentSessionId)
    .terminalPromptSubmission?.submit.acknowledged,
  true
)
assert.equal(
  (await promptSubmitBeforeAckRecovered.statusAgent(
    promptSubmitBeforeAckCrashCheckpoint.agentSessionId
  )).run.acceptedInputBytes,
  promptSubmitBeforeAckCrashCheckpoint.submitRange.endByte
)
assert.equal(
  (await promptSubmitBeforeAckRecovered.sessionTimeline(
    promptSubmitBeforeAckCrashCheckpoint.agentSessionId
  )).items.filter((item) => (
    item.kind === 'user_message' && item.content === 'crash-between-phases'
  )).length,
  1
)
await promptSubmitBeforeAckRecovered.stopAgent(
  promptSubmitBeforeAckCrashCheckpoint.agentSessionId,
  { runId: promptSubmitBeforeAckCrashCheckpoint.runId }
)
await promptSubmitBeforeAckRecovered.dispose()

const interactionCrashWorker = spawnOwned(process.execPath, [interactionCrashFixture], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AGENTMUX_FAKE_CODEX: fakeCodex }
})
const interactionCrashCheckpoint = await firstJsonLine(
  interactionCrashWorker,
  'interaction response crash worker'
)
assert.equal(interactionCrashCheckpoint.type, 'interaction-input-applied-before-store-ack')
const [interactionCrashCode] = await once(interactionCrashWorker, 'exit')
assert.equal(interactionCrashCode, 94)

const interactionRecovered = await connectLocalAgentMux()
const recoveredInteractionSession = interactionRecovered.agentSession(
  interactionCrashCheckpoint.agentSessionId
)
assert.equal(recoveredInteractionSession.pendingInteraction, undefined)
const recoveredInteractionRun = await interactionRecovered.statusAgent(
  interactionCrashCheckpoint.agentSessionId
)
assert.equal(recoveredInteractionRun.run.state, 'exited')
assert.ok(
  recoveredInteractionRun.run.acceptedInputBytes >= interactionCrashCheckpoint.inputByteRange.endByte
)
await interactionRecovered.stopAgent(
  interactionCrashCheckpoint.agentSessionId,
  { runId: interactionCrashCheckpoint.runId }
)
await interactionRecovered.dispose()

const acpStore = new AgentMuxFileAgentSessionStore()
const acpSession = {
  kind: 'agent',
  agentSessionId: 'acp-semantic',
  providerId: 'codex',
  executorId: 'codex',
  hostId: 'local',
  workspacePath: process.cwd(),
  run: { runId: '00000000-0000-4000-8000-000000000001' },
  retiredRuns: [],
  hookBindingId: 'acp-synthetic-binding',
  hookToken: 'acp-synthetic-token',
  outputCursorBytes: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  nativeHandle: { kind: 'acp', adapterId: 'packed-acp', sessionId: 'packed-native' }
}
await acpStore.compareAndSwap(null, acpSession)
const resolvedAcp = JSON.parse((await cli([
  'inspect', '--acp-native', 'packed-native', '--adapter', 'packed-acp'
])).stdout)
assert.equal(resolvedAcp.result.session.agentSessionId, acpSession.agentSessionId)
await controlServer.stop()
const earlyCloseRoot = await mkdtemp('/private/tmp/agentmux-packed-control-close-')
const earlyClosePath = join(earlyCloseRoot, 'control.sock')
const earlyCloseSockets = new Set()
const earlyCloseServer = createServer((socket) => {
  earlyCloseSockets.add(socket)
  socket.once('close', () => earlyCloseSockets.delete(socket))
  socket.end('{"schemaVersion":')
})
await new Promise((resolve, reject) => {
  earlyCloseServer.once('error', reject)
  earlyCloseServer.listen(earlyClosePath, resolve)
})
await assert.rejects(
  requestAgentMuxControl({
    schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: 'packed-peer-close',
    operation: 'list.agents'
  }, earlyClosePath),
  (error) => error?.code === 'CONTROL_PROTOCOL_ERROR'
)
await new Promise((resolve) => {
  earlyCloseServer.close(resolve)
  for (const socket of earlyCloseSockets) socket.destroy()
})
await rm(earlyCloseRoot, { recursive: true, force: true })
const missingStopClient = await connectLocalAgentMux()
await missingStopClient.stopAgent(acpSession.agentSessionId, acpSession.run)
assert.equal((await missingStopClient.ensureAgentContinuity({
  agentSessionId: acpSession.agentSessionId,
  expectedRun: acpSession.run,
  operationId: 'packed-missing-run-retirement'
})).kind, 'retired')
assert.equal((await missingStopClient.ensureAgentContinuity({
  agentSessionId: 'another-agent-session',
  expectedRun: acpSession.run,
  operationId: 'packed-cross-session-retirement'
})).kind, 'unavailable')
await missingStopClient.dispose()

const crashWorker = spawnOwned(process.execPath, [lifecycleCrashFixture], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AGENTMUX_FAKE_CODEX: fakeCodex }
})
const crashCheckpoint = await firstJsonLine(crashWorker, 'lifecycle crash worker')
assert.equal(crashCheckpoint.type, 'run-started-before-commit')
const beforeCrashRecovery = await connectLocalAgentMux()
const uncommittedRun = (await beforeCrashRecovery.listRuns()).find(
  (run) => run.runId === crashCheckpoint.runId
)
assert.equal(uncommittedRun?.state, 'running')
assert.ok(uncommittedRun?.pid)
await beforeCrashRecovery.dispose()
crashWorker.kill('SIGKILL')
await once(crashWorker, 'exit')
const afterCrashRecovery = await connectLocalAgentMux()
assert.deepEqual(afterCrashRecovery.agentSessions(), [])
assert.equal((await afterCrashRecovery.listRuns()).some(
  (run) => run.runId === crashCheckpoint.runId
), false)
assert.equal(await processIsGone(uncommittedRun.pid), true)
assert.throws(
  () => afterCrashRecovery.resolveAgentSession({ kind: 'run', run: { runId: crashCheckpoint.runId } }),
  (error) => error?.code === 'STALE_AGENT_SESSION_BINDING'
)
await afterCrashRecovery.dispose()

await assert.rejects(
  connectSshAgentMux({ target: { hostId: 'remote', hostname: 'example.invalid' } }),
  (error) => error?.code === 'REMOTE_UNSUPPORTED'
)
const cleanupSentinel = await third.createTerminal({
  workspacePath: process.cwd(),
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1_000)']
})
assert.ok(cleanupSentinel.pid)
await third.dispose()

process.stdout.write(`${JSON.stringify({
  runId: run.runId,
  pid: originalPid,
  replayStartByte: suffix.replay[0]?.startByte,
  sharedReplayWhileAttached: true,
  agentSharedReplayWhileAttached: true,
  multiViewAcknowledgementMonotonic: true,
  resize: '101x37',
  interruptStillLive: true,
  dedupOccurrences,
  stubbornPids,
  codexSemanticSession: codex.agentSessionId,
  codexNativeSession: 'native-codex-semantic-1',
  semanticContinuity: 'conflict-resumed-retired',
  terminalHandshake: 'query-ack-prompt',
  stopEpochReadiness: [
    'missing-stop-rejected-before-payload',
    'tail-lookbehind-ready',
    'post-cursor-live-ready',
    'concurrent-single-consumer',
    'crash-recovered-once'
  ],
  promptCrashRecovery: true,
  interactionCrashRecovery: true,
  cliResolveKinds: ['agent-session', 'provider-native', 'acp-native', 'run'],
  cliControl: true,
  naturalTerminalStop: true,
  crashRecovery: true,
  cleanupSentinelPid: cleanupSentinel.pid,
  remote: 'unsupported'
})}\n`)
