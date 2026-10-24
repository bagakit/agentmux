import { existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
const { startHeadlessAgentMux } = await import(pathToFileURL(process.env.AGENTMUX_TEST_HANDOFF_CORE_ENTRY).href)
const { CtxmuxClient } = await import(pathToFileURL(process.env.AGENTMUX_TEST_HANDOFF_SDK_ENTRY).href)
const directory = process.env.AGENTMUX_STATE_DIRECTORY
const log = value => appendFileSync(join(directory, 'handoff-owner.jsonl'), JSON.stringify(value) + '\n')
let sequence = 0
for (const method of ['attach', 'attachTerminal']) {
  const open = CtxmuxClient.prototype[method]
  CtxmuxClient.prototype[method] = async function (...args) {
    const attachment = await open.apply(this, args), id = ++sequence
    log({ event: 'opened', id, method, runId: args[0], afterByte: args[1], cut: attachment.snapshot.run.latest_output_bytes })
    const events = attachment.events.bind(attachment), detach = attachment.detach.bind(attachment), close = attachment.close.bind(attachment)
    let retired = false
    attachment.events = async function* () {
      log({ event: 'pump', id, runId: args[0] })
      for await (const event of events()) {
        if ((event.type === 'output' || event.type === 'resized') && existsSync(join(directory, 'hold-pump'))) {
          log({ event: 'held', id, runId: args[0], type: event.type })
          while (!retired && existsSync(join(directory, 'hold-pump'))) await delay(10)
        }
        if (retired) return
        yield event
      }
    }
    attachment.detach = async () => { retired = true; try { return await detach() } finally { log({ event: 'detached', id, runId: args[0] }) } }
    attachment.close = () => { retired = true; close(); log({ event: 'closed', id, runId: args[0] }) }
    return attachment
  }
}
const owner = await startHeadlessAgentMux({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock') })
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
process.once('SIGTERM', () => { void owner.stop() })
process.once('SIGINT', () => { void owner.stop() })
