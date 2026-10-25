// Controlled native CLI leaf. Core, the Provider, Hook ingress and ctxmux stay real.
import { appendFileSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

if (process.argv.includes('--version')) { process.stdout.write('controlled-claude 1\n'); process.exit(0) }
const directory = process.env.HOST_CHANNEL_NATIVE_DIRECTORY
const witness = process.env.HOST_CHANNEL_NATIVE_WITNESS
const session = process.env.AGENTMUX_AGENT_SESSION_ID
const url = process.env.AGENTMUX_HOOK_URL, token = process.env.AGENTMUX_HOOK_TOKEN
if (!directory || !witness || !session || !url || !token) throw Error('Private native fixture context is missing')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const nativeId = randomUUID(), sourceId = randomUUID(), transcript = join(directory, nativeId + '.jsonl')
const fd = openSync(transcript, 'wx', 0o600)
let ordinal = 0, sequence = 0, turn = 0, composer = '', pending = '', chain = Promise.resolve()
const record = (type, text) => writeSync(fd, JSON.stringify({ type, uuid: randomUUID(), sessionId: nativeId, isSidechain: false,
  message: { role: type, content: [{ type: 'text', text }] } }) + '\n')
const fact = value => appendFileSync(witness, JSON.stringify({ pid: process.pid, session, nativeId, ...value }) + '\n', { mode: 0o600 })
async function hook(eventName, extra = {}) {
  const body = JSON.stringify({ receiptId: 'channel-native-' + ++ordinal, eventName,
    payload: { hook_event_name: eventName, session_id: nativeId, transcript_path: transcript, ...extra } })
  const end = Date.now() + 30_000
  for (;;) {
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body })
    if (response.ok) return
    const failure = await response.json()
    if (failure.retryable !== true || Date.now() > end) throw Error('Original Hook ingress rejected ' + eventName + ': ' + response.status + ': ' + JSON.stringify(failure))
    await new Promise(done => setTimeout(done, 50))
  }
}
const frame = text => process.stdout.write('\x1b[?2026h\x1b[22;1H❯ ' + text.replaceAll('\n', '\x1b[K\r\n') + '\x1b[K\x1b[?2026l')
async function activity(eventName) {
  await hook(eventName, { sourceId, sequence: ++sequence, turnId: 'controlled-turn-' + turn,
    ...(eventName === 'turn.complete' ? { reason: 'answer', isAborted: false } : {}) })
}
async function answer(text) {
  turn++; await activity('turn.start'); record('user', text); fact({ kind: 'input', text })
  record('assistant', 'Controlled reply: ' + createHash('sha256').update(text).digest('hex')); frame(''); await activity('turn.complete')
}
record('assistant', 'Original private transcript before sharing')
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8')
process.stdin.on('data', bytes => {
  pending += bytes
  pending = pending.replaceAll('\x1b[?0u', '')
  const start = '\x1b[200~', end = '\x1b[201~'
  if (start.startsWith(pending) && pending !== '') return
  if (pending.startsWith(start)) {
    const at = pending.indexOf(end, start.length)
    if (at < 0) return
    composer += pending.slice(start.length, at); pending = pending.slice(at + end.length)
    frame(composer)
  }
  for (const character of pending) {
    if (character === '\r' || character === '\n') {
      if (!composer) continue
      const text = composer; composer = ''
      chain = chain.then(() => answer(text)).catch(error => { process.stderr.write(String(error.stack ?? error)); process.exit(1) })
    } else { composer += character; frame(composer) }
  }
  pending = ''
})
process.stdout.write('\x1b[?u')
await hook('SessionStart', { source: 'startup' })
await activity('turn.start'); frame(''); await activity('turn.complete')
fact({ kind: 'ready', transcript })
