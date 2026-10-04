// A private ordered CLI peer, with real OS pipes and explicit write backpressure.
import { readFileSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
const input = JSON.parse(readFileSync(process.env.AGENTMUX_PROTOCOL_INPUT, 'utf8'))
writeFileSync(process.env.AGENTMUX_PROTOCOL_PID, String(process.pid))
let sent = 0
for (const frame of input.frames) {
  const bytes = input.rawHex ? Buffer.from(input.rawHex, 'hex') : Buffer.from(JSON.stringify(frame) + '\n')
  const width = input.fragment ?? bytes.length
  for (let offset = 0; offset < bytes.length; offset += width) {
    if (!process.stdout.write(bytes.subarray(offset, offset + width))) await once(process.stdout, 'drain')
  }
  writeFileSync(process.env.AGENTMUX_PROTOCOL_PROGRESS, String(++sent))
}
if (input.linger) setInterval(() => {}, 1000)
