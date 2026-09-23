import { appendFileSync } from 'node:fs'

const trace = process.env.AMX_COLOR_TRACE
const markers = ['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CI', 'CODEX_CI', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION']
const environment = Object.fromEntries(markers.map(key => [key, process.env[key] ?? null]))
const record = value => appendFileSync(trace, JSON.stringify({ ...value, pid: process.pid }) + '\n')
const color = () => process.stdout.write(environment.NO_COLOR === null && environment.FORCE_COLOR !== '0' && environment.CLICOLOR !== '0'
  ? '\x1b[31mANSI16\x1b[0m \x1b[38;5;208mANSI256\x1b[0m \x1b[38;2;10;120;240mRGB\x1b[0m\r\n'
  : 'ANSI16 ANSI256 RGB\r\n')
record({ type: 'start', environment, cwd: process.cwd(), argv: process.argv.slice(2) })
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.resume()
let pending = '', ready = false
process.stdin.on('data', async data => {
  pending += data
  if (!ready) {
    const end = pending.indexOf('\x1b[?0u')
    if (end < 0) return
    pending = pending.slice(end + 5)
    ready = true
    const response = await fetch(process.env.AGENTMUX_HOOK_URL, {
      method: 'POST', headers: { authorization: `Bearer ${process.env.AGENTMUX_HOOK_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: `color-start-${process.pid}`, eventName: 'SessionStart',
        payload: { hook_event_name: 'SessionStart', session_id: process.env.AMX_COLOR_NATIVE_ID } })
    })
    record({ type: 'hook', status: response.status })
    color()
    record({ type: 'ready' })
  }
  let end
  while ((end = pending.indexOf('\r')) !== -1) {
    const input = pending.slice(0, end); pending = pending.slice(end + 1)
    record({ type: 'input', input })
    if (input === 'EXIT:23') process.exit(23)
    color()
  }
})
process.stdout.write('\x1b[?u')
