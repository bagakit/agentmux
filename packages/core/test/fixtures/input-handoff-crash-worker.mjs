import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHeadlessAgentMux } from '../../dist/index.js'

const state = process.env.AGENTMUX_STATE_DIRECTORY
const owner = await startHeadlessAgentMux({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'handoff.sock') })
const queue = Reflect.get(owner.client, 'messageQueue'), gate = queue.authorizeInputDispatch.bind(queue)
queue.authorizeInputDispatch = async (...args) => {
  const result = await gate(...args)
  if (result && existsSync(join(state, 'hold-after-gate'))) {
    writeFileSync(join(state, 'gate-witness.json'), JSON.stringify(result))
    await new Promise(() => {})
  }
  return result
}
const kernel = Reflect.get(owner.client, 'kernel'), input = kernel.input.bind(kernel)
kernel.input = async (run, request) => {
  appendFileSync(join(state, 'effect-calls.jsonl'), JSON.stringify({ run, operationId: request.operationId }) + '\n')
  const result = await input(run, request)
  if (existsSync(join(state, 'hold-after-effect'))) {
    writeFileSync(join(state, 'effect-witness.json'), JSON.stringify(result))
    await new Promise(() => {})
  }
  return result
}
if (existsSync(join(state, 'provider-drift'))) owner.client.providers.get('pi').planPromptInput = () => { throw Error('Provider must not reselect a retained gate carrier') }
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
process.once('SIGTERM', () => { void owner.stop() })
