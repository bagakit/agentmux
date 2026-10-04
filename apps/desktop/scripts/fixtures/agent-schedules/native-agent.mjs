import { appendFileSync, watch } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const hook = async (eventName, receiptId) => {
  const response = await fetch(process.env.AGENTMUX_HOOK_URL, { method: 'POST', headers: { authorization: `Bearer ${process.env.AGENTMUX_HOOK_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ receiptId, agentSessionId: process.env.AGENTMUX_AGENT_SESSION_ID, runId: process.env.AGENTMUX_RUN_ID, providerId: process.env.AGENTMUX_PROVIDER_ID, eventName, payload: { session_id: 'schedule-native-session' } }) })
  if (!response.ok) throw new Error(`Private hook ${eventName}: ${response.status}`)
}
await hook('SessionStart', 'private-start')
await hook('Stop', 'private-idle')
process.stdout.write('private-schedule-agent-ready\n')
// Exercise actual managed CLI ingress without exporting or logging its raw
// capability. The CLI subprocess inherits only this private native Run's env.
const completedCommands = new Set(), runCli = promisify(execFile)
if (process.env.SCHEDULE_PROBE_COMMAND_DIR) watch(process.env.SCHEDULE_PROBE_COMMAND_DIR, (_event, filename) => {
  if (!filename?.endsWith('.request.json') || completedCommands.has(filename)) return
  completedCommands.add(filename)
  void (async () => {
    const path = join(process.env.SCHEDULE_PROBE_COMMAND_DIR, filename), request = JSON.parse(await readFile(path, 'utf8'))
    const dataPath = path.replace('.request.json','.data.json'); await writeFile(dataPath,JSON.stringify(request.params))
    let response
    try {
      const result = await runCli(process.execPath, [process.env.SCHEDULE_PROBE_CLI, 'schedule', request.action, '--data', dataPath], {
        env: { ...process.env, AGENTMUX_RPC_ENDPOINT: process.env.SCHEDULE_PROBE_ENDPOINT }, timeout: 15000
      })
      response = { code: 0, body: JSON.parse(result.stdout.trim().split('\n').at(-1)) }
    } catch (error) { response = { code: error.code, body: JSON.parse((error.stdout || error.stderr).trim().split('\n').at(-1)) } }
    await writeFile(path.replace('.request.json','.response.json'),JSON.stringify(response))
  })().catch(error => { process.stderr.write('Private managed CLI command failed: '+error.message+'\n') })
})
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let sequence = 0
process.stdin.on('data', async data => {
  appendFileSync(process.env.SCHEDULE_PROBE_LOG, JSON.stringify({ sequence: ++sequence, data }) + '\n')
  process.stdout.write('private-input-accepted\n')
  await hook('UserPromptSubmit', `private-input-${sequence}`)
  await hook('Stop', `private-end-${sequence}`)
})
