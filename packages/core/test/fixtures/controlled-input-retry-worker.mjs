import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHeadlessAgentMux, AgentMuxError } from '../../dist/index.js'

const owner = await startHeadlessAgentMux({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock') })
// Control only the Runtime input boundary; intake, journal, claims and public
// transport are the actual owner. Accepted input still uses its real ctxmux PTY.
const kernel = Reflect.get(owner.client, 'kernel'), write = kernel.input.bind(kernel)
kernel.input = async (run, input) => {
  const path = join(process.env.AGENTMUX_STATE_DIRECTORY, 'input-failure')
  if (existsSync(path)) {
    const failure = JSON.parse(readFileSync(path, 'utf8'))
    throw new AgentMuxError('Private Runtime refused the whole input before any PTY bytes.', 'CTXMUX_input_cursor_mismatch', failure.disposition, failure)
  }
  return await write(run, input)
}
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
process.once('SIGTERM', () => { void owner.stop() })
process.once('SIGINT', () => { void owner.stop() })
