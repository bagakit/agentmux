#!/usr/bin/env node
const args = process.argv.slice(2)
const isResume = args[0] === 'resume'
const prompt = isResume ? args[2] ?? '' : args.at(-1) ?? ''
const hookUrl = process.env.AGENTMUX_HOOK_URL
const hookToken = process.env.AGENTMUX_HOOK_TOKEN
const agentSessionId = process.env.AGENTMUX_AGENT_SESSION_ID
const agentId = process.env.AGENTMUX_AGENT_ID
const readyMode = process.env.AGENTMUX_FAKE_READY_MODE ?? 'before'

if (!hookUrl || !hookToken || !agentSessionId || !agentId) {
  throw new Error('missing AgentMux hook environment')
}
if (
  process.env.TERM !== 'xterm-256color' ||
  process.env.COLORTERM !== 'truecolor' ||
  process.env.NO_COLOR !== undefined
) {
  throw new Error('AgentMux did not provide a color-capable terminal environment')
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
let controlledReadyPending = false
let resolveHandshake
const handshake = new Promise((resolve) => { resolveHandshake = resolve })
const writeComposerFrame = (value) => {
  process.stdout.write('\u001b[?2026h\u001b[1m›\u001b[0m')
  for (const [index, character] of Array.from(value).entries()) {
    process.stdout.write(`\u001b[${index % 2 === 0 ? '32' : '36'}m${character}\u001b[0m`)
  }
  process.stdout.write('\u001b[?2026l')
  process.stdout.write(`codex-composer-rendered:${Buffer.byteLength(value)}\n`)
}
const writeComposerNearMiss = (value) => {
  process.stdout.write(`\u001b[?2026h›${Array.from(value).join('·')}\u001b[?2026l`)
  process.stdout.write('codex-composer-near-miss\n')
}
const writeReadyFrame = () => {
  tuiReady = true
  controlledReadyPending = false
  process.stdout.write('codex-composer-ready-frame\n')
  process.stdout.write('\u001b[?2026h\u001b[1m›\u001b[?25h\u001b[?2026l')
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
  if (readyMode === 'no-stop') {
    writeReadyFrame()
    return
  }
  if (readyMode === 'before') {
    writeReadyFrame()
    await publishStop()
    return
  }
  if (readyMode === 'after') {
    await publishStop()
    controlledReadyPending = true
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
    })
  }
})
process.on('SIGINT', () => {
  process.stdout.write('codex-interrupt\n')
})
process.stdout.write('\u001b[?u')
await handshake
await request({
  receiptId: `session-start-${agentSessionId}`,
  eventName: 'SessionStart',
  payload: { session_id: `native-${agentSessionId}`, prompt }
})
await request({
  receiptId: `permission-${agentSessionId}`,
  eventName: 'PermissionRequest',
  payload: { session_id: `native-${agentSessionId}`, tool_name: 'request_user_input' }
})
process.stdout.write(`codex-ready:${prompt}\n`)
await settleTurn()
