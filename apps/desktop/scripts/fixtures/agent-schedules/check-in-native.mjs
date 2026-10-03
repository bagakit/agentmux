import { openSync, writeSync, appendFileSync, watch } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const transcript = process.env.SCHEDULE_PROBE_TRANSCRIPT, fd = openSync(transcript, 'a'), nativeId = 'private-check-in-native'
if ((await readFile(transcript)).length === 0) writeSync(fd, JSON.stringify({ kind: 'session', id: nativeId }) + '\n')
const record = value => writeSync(fd, JSON.stringify(value) + '\n')
const hook = async (eventName, receiptId) => {
  const response = await fetch(process.env.AGENTMUX_HOOK_URL, { method: 'POST', headers: { authorization: `Bearer ${process.env.AGENTMUX_HOOK_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ receiptId, agentSessionId: process.env.AGENTMUX_AGENT_SESSION_ID, runId: process.env.AGENTMUX_RUN_ID, providerId: process.env.AGENTMUX_PROVIDER_ID, eventName, payload: { session_id: nativeId, transcript_path: transcript } }) })
  if (!response.ok) throw new Error(`Private hook ${eventName}: ${response.status}`)
}
const frame = () => process.stdout.write('\u001b[?2026h\u001b[2J\u001b[Hprivate-ready>\u001b[?2026l')
await hook('SessionStart', 'private-checkin-start'); record({ kind: 'end', id: 'initial-idle' }); await hook('Stop', 'private-checkin-idle'); frame()
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let sequence = 0, serial = Promise.resolve()
process.stdin.on('data', data => {
  const id = 'native-input-' + ++sequence, createdAt = Date.now()
  record({ kind: 'input', id, createdAt, text: data })
  appendFileSync(process.env.SCHEDULE_PROBE_LOG, JSON.stringify({ sequence, data, createdAt }) + '\n')
  serial = serial.then(async () => { await hook('UserPromptSubmit', id); record({ kind: 'end', id: id + '-end' }); await hook('Stop', id + '-end'); frame() })
})
// The native process's managed CLI uses its real inherited capability.
const completed = new Set(), runCli = promisify(execFile)
watch(process.env.SCHEDULE_PROBE_COMMAND_DIR, (_event, filename) => {
  if (!filename?.endsWith('.request.json') || completed.has(filename)) return
  completed.add(filename)
  void (async () => {
    const path = join(process.env.SCHEDULE_PROBE_COMMAND_DIR, filename), request = JSON.parse(await readFile(path, 'utf8')), dataPath = path.replace('.request.json', '.data.json')
    await writeFile(dataPath, JSON.stringify(request.params))
    let response
    try { const result = await runCli(process.execPath, [process.env.SCHEDULE_PROBE_CLI, 'schedule', request.action, '--data', dataPath], { env: { ...process.env, AGENTMUX_RPC_ENDPOINT: process.env.SCHEDULE_PROBE_ENDPOINT }, timeout: 15000 }); response = { code: 0, body: JSON.parse(result.stdout.trim().split('\n').at(-1)) } }
    catch (error) { response = { code: error.code, body: JSON.parse((error.stdout || error.stderr).trim().split('\n').at(-1)) } }
    await writeFile(path.replace('.request.json', '.response.json'), JSON.stringify(response))
  })().catch(error => process.stderr.write(error.stack + '\n'))
})
