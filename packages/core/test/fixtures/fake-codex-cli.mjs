#!/usr/bin/env node
const args = process.argv.slice(2)
const nonFlags = args.filter((arg) => !arg.startsWith('-'))
const resumeIndex = nonFlags.indexOf('resume')
const isResume = resumeIndex !== -1
const prompt = isResume ? nonFlags[resumeIndex + 2] ?? '' : (args.at(-1)?.startsWith('-') ? '' : args.at(-1) ?? '')
const hookUrl = process.env.AGENTMUX_HOOK_URL
const hookToken = process.env.AGENTMUX_HOOK_TOKEN
const agentSessionId = process.env.AGENTMUX_AGENT_SESSION_ID
const providerId = process.env.AGENTMUX_PROVIDER_ID
const readyMode = process.env.AGENTMUX_FAKE_READY_MODE ?? 'before-delayed'
const promptRenderMode = process.env.AGENTMUX_FAKE_PROMPT_RENDER_MODE ?? 'normal'
const publishPermissionRequest = process.env.AGENTMUX_FAKE_PERMISSION_REQUEST === '1'
const exitAfterPermission = process.env.AGENTMUX_FAKE_EXIT_AFTER_PERMISSION === '1'
const handshakeQueryDelay = Number(process.env.AGENTMUX_FAKE_HANDSHAKE_QUERY_DELAY_MS ?? '0')

if (!hookUrl || !hookToken || !agentSessionId || !providerId) {
  throw new Error('missing AgentMux hook environment')
}
if (
  process.env.TERM !== 'xterm-256color' ||
  process.env.COLORTERM !== 'truecolor' ||
  process.env.NO_COLOR !== undefined
) {
  throw new Error('AgentMux did not provide a color-capable terminal environment')
}
if (
  process.env.AGENTMUX_ENV !== '1' ||
  !process.env.AGENTMUX_CLI?.endsWith('/bin/agentmux') ||
  !process.env.PATH?.split(':').includes(process.env.AGENTMUX_CLI.slice(0, -'/agentmux'.length))
) {
  throw new Error('AgentMux did not provide its managed CLI environment')
}

/**
 * 往 AgentMux 的 hook ingress 投一条事件，直到它收下。
 *
 * **重试没有次数上限，但每 10 秒把自己在等什么写到 stderr。** 唯一的失败模式是"ingress 起不来"，
 * 而那由外层期限显形（跑这个假 CLI 的那条 it 有自己的超时）。原先是 100 次 × 100ms = 10 秒上限，
 * 然后抛 `AgentMux hook ingress did not return`——这就是 test:native 那个负载相关 flake 的**根**：
 *
 * 机器被压满时 ingress 需要的时间超过 10 秒，于是 `publishStop()` 抛错。调用点是 `void settleTurn()`
 * （见下面 :231），所以那个抛出变成没人看的 unhandled rejection：**没有任何日志记录它**。
 * 而 `settleTurn` 因此没走到 `writeDiagnostic('codex-controlled-ready-pending')`，
 * 于是 packed-consumer 那侧永远等不到这个标记。一个 10 秒的重试预算，最终表现成
 * "handshake 超时"——追了五层才到这里。
 *
 * 挂钟/次数预算适合"对端可能永不回答"；这里对端是同一次测试自己起的进程，它一定会答，只是可能慢。
 *
 * 但**去掉上限不等于可以沉默**：实测 2026-09-01 有一轮 `handshake race controlled composer pending`
 * 一路等到 80 秒被外层掐掉，而这一侧一个字都没留——因为这个假 CLI 跑在 PTY 里，stderr 不经
 * packed-consumer 转发，一次永等就是完全无痕的。所以这里跟 packed-consumer 的 `waitFor` 同一处置：
 * 不设上限，但周期性点名自己卡在哪一次投递上，让真的卡死指得到位点。
 *
 * 这一行为什么不会污染断言：PTY 把 stderr 与 stdout 合流，所以它**会**出现在 terminal-output 里
 * （实测确认，不是推测）。安全性不来自"我写的字恰好不撞现有断言"那种巧合，而来自触发条件——
 * 第一行要等满 10 秒才写，而正常一轮里每次投递都是毫秒级，于是正常路径**一行都不写**。
 * 只有已经卡死（那一轮注定要失败）时才会有输出，此时污染断言已无意义。改这个阈值前先想清楚这一点。
 */
const request = async (body) => {
  const started = Date.now()
  let announced = 0
  for (;;) {
    try {
      const response = await fetch(hookUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${hookToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      })
      if (response.ok) return response
    } catch {}
    const waited = Date.now() - started
    if (waited >= (announced + 1) * 10_000) {
      announced = Math.floor(waited / 10_000)
      process.stderr.write(
        `fake-codex-cli: hook ingress has not accepted ${body.eventName} (${body.receiptId}) after ${Math.round(waited / 1000)}s\n`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

process.stdin.setRawMode?.(true)
process.stdin.setEncoding('utf8')
let protocolInput = ''
let observedHandshake = false
let tuiReady = false
let composer = ''
let composerReady = false
let renderGeneration = 0
let stopGeneration = 0
let payloadStopPublished = false
let controlledReadyPending = false
let resolveHandshake
let permissionPending = false
let resolvePermission
let terminalProtocolInput = ''
const handshake = new Promise((resolve) => { resolveHandshake = resolve })
const permission = new Promise((resolve) => { resolvePermission = resolve })
const decodeTerminalInput = (data) => {
  const start = '\u001b[200~'
  const end = '\u001b[201~'
  terminalProtocolInput += data
  if (start.startsWith(terminalProtocolInput)) return null
  if (!terminalProtocolInput.startsWith(start)) {
    const decoded = terminalProtocolInput
    terminalProtocolInput = ''
    return decoded
  }
  const endIndex = terminalProtocolInput.indexOf(end, start.length)
  if (endIndex < 0) return null
  const decoded = terminalProtocolInput.slice(start.length, endIndex) +
    terminalProtocolInput.slice(endIndex + end.length)
  terminalProtocolInput = ''
  return decoded
}
const writeDiagnostic = (value) => {
  process.stdout.write(`\u001b[s\u001b[24;1H${value}\u001b[K\u001b[u`)
}
const writeComposerFrame = (value) => {
  process.stdout.write('\u001b[?2026h\u001b[22;3H')
  for (const [index, character] of Array.from(value).entries()) {
    if (character === '\n') {
      process.stdout.write('\u001b[K\r\n')
      continue
    }
    process.stdout.write(`\u001b[${index % 2 === 0 ? '32' : '36'}m${character}\u001b[0m`)
  }
  process.stdout.write('\u001b[K\u001b[?2026l')
  writeDiagnostic(`codex-composer-rendered:${Buffer.byteLength(value)}`)
}
const writeHistoricalPromptMatch = (value) => {
  process.stdout.write(`\u001b[?2026h\u001b[5;1H› ${value}\u001b[22;3H\u001b[?2026l`)
  writeDiagnostic('codex-historical-prompt-match')
}
const writeComposerNearMiss = (value) => {
  process.stdout.write(`\u001b[?2026h›${Array.from(value).join('·')}\u001b[?2026l`)
  writeDiagnostic('codex-composer-near-miss')
}
const writeReadyFrame = () => {
  tuiReady = true
  controlledReadyPending = false
  process.stdout.write('codex-composer-ready-frame\n')
  process.stdout.write('\u001b[?2026h\u001b[22;1H\u001b[1m›\u001b[0m \u001b[K\u001b[22;3H\u001b[?25h\u001b[?2026l')
}
const writeAssistantMarkerWithoutComposer = () => {
  process.stdout.write('\u001b[2J\u001b[5;1H› assistant text only\u001b[22;1Hstatus\u001b[22;7H')
  writeDiagnostic('codex-assistant-marker-without-composer')
}
const publishStop = async () => {
  stopGeneration += 1
  await request({
    receiptId: `stop-${agentSessionId}-${stopGeneration}`,
    eventName: 'Stop',
    payload: { session_id: `native-${agentSessionId}` }
  })
}
const settleTurn = async () => {
  if (readyMode === 'no-stop' || readyMode === 'stop-after-payload') {
    controlledReadyPending = true
    writeDiagnostic('codex-controlled-ready-pending')
    return
  }
  if (readyMode === 'no-stop-assistant') {
    writeAssistantMarkerWithoutComposer()
    controlledReadyPending = true
    writeDiagnostic('codex-controlled-ready-pending')
    return
  }
  if (readyMode === 'pre-handshake-composer') {
    controlledReadyPending = true
    writeDiagnostic('codex-post-handshake-status-only')
    return
  }
  if (readyMode === 'before') {
    writeReadyFrame()
    await publishStop()
    return
  }
  if (readyMode === 'before-delayed') {
    writeReadyFrame()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await publishStop()
    return
  }
  if (readyMode === 'after') {
    await publishStop()
    controlledReadyPending = true
    writeDiagnostic('codex-controlled-ready-pending')
    return
  }
  if (readyMode === 'after-assistant') {
    await publishStop()
    writeAssistantMarkerWithoutComposer()
    controlledReadyPending = true
    writeDiagnostic('codex-controlled-ready-pending')
    return
  }
  throw new Error(`unknown fake readiness mode: ${readyMode}`)
}
process.stdin.on('data', (data) => {
  if (data.includes('\u001b[?7u') || data.includes('\u001b[13u')) {
    process.stdout.write('codex-unexpected-kitty-capability\n')
    process.exit(2)
  }
  if (!observedHandshake) {
    protocolInput += data
    if (protocolInput.includes('\u001b[?0u')) {
      observedHandshake = true
      process.stdout.write('codex-handshake:kitty-flags-0\n')
      resolveHandshake()
    }
    return
  }
  if (permissionPending) {
    if (data === '1' || data === '\u001b') {
      permissionPending = false
      writeDiagnostic(data === '1' ? 'codex-permission-allowed' : 'codex-permission-cancelled')
      resolvePermission()
      if (exitAfterPermission) setImmediate(() => process.exit(0))
    } else {
      writeDiagnostic('codex-unexpected-permission-input')
    }
    return
  }
  const decodedInput = decodeTerminalInput(data)
  if (decodedInput === null) return
  data = decodedInput
  if (controlledReadyPending && data === '\u001d') {
    writeReadyFrame()
    return
  }
  if (!tuiReady) {
    if (data.replaceAll('\r', '')) {
      process.stdout.write('codex-dropped-pre-ready-payload\n')
    }
    if (data.includes('\r')) process.stdout.write('codex-ignored-early-enter\n')
    return
  }
  if (!data.includes('\r') && Array.from(data).length > 1) writeComposerNearMiss(data)
  if (
    promptRenderMode === 'historical-match' &&
    !data.includes('\r') &&
    Array.from(data).length > 1
  ) writeHistoricalPromptMatch(data)
  for (const character of data) {
    if (character === '\r') {
      if (!composerReady) {
        renderGeneration += 1
        composer = ''
        process.stdout.write('codex-ignored-early-enter\n')
        continue
      }
      const submitted = composer
      composer = ''
      composerReady = false
      renderGeneration += 1
      process.stdout.write(`codex-submit:${submitted}:accepted\n`)
      if (submitted === 'exit') process.exit(0)
      tuiReady = false
      // 不能裸 `void`：settleTurn 里有 await 的网络投递，它抛出时会变成没人看的 unhandled
      // rejection，而症状出现在**另一侧**——packed-consumer 永远等不到 settleTurn 本该写的标记。
      // 那个组合让一次投递失败伪装成 handshake 超时，实测追了五层才定位。所以让它响亮地死。
      void settleTurn().catch((error) => {
        process.stderr.write(`fake-codex-cli: settleTurn failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
        process.exit(1)
      })
      continue
    }
    composer += character
    composerReady = false
    const generation = ++renderGeneration
    setImmediate(() => {
      if (generation !== renderGeneration || !composer) return
      composerReady = true
      writeComposerFrame(composer)
      if (readyMode === 'stop-after-payload' && !payloadStopPublished) {
        payloadStopPublished = true
        void publishStop()
      }
    })
  }
})
process.on('SIGINT', () => {
  writeDiagnostic('codex-interrupt')
})
if (handshakeQueryDelay > 0) {
  await new Promise((resolve) => setTimeout(resolve, handshakeQueryDelay))
}
process.stdout.write('\u001b[?u')
if (readyMode === 'pre-handshake-composer') writeReadyFrame()
await handshake
if (process.env.AGENTMUX_FAKE_OMIT_HANDLE !== '1') {
  await request({
    receiptId: `session-start-${agentSessionId}`,
    eventName: 'SessionStart',
    payload: { session_id: `native-${agentSessionId}`, prompt }
  })
  if (publishPermissionRequest) {
    permissionPending = true
    await request({
      receiptId: `permission-${agentSessionId}`,
      eventName: 'PermissionRequest',
      payload: { session_id: `native-${agentSessionId}`, tool_name: 'request_user_input' }
    })
    await permission
  }
}
process.stdout.write(`codex-ready:${prompt}\n`)
await settleTurn()
