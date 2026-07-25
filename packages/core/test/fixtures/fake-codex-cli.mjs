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

const request = async (body) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('AgentMux hook ingress did not return')
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
      void settleTurn()
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
