import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { createExecutionFrameChannel } from '../src/agent-execution-channel.js'

it('closing a reader never destroys its original helper input', async () => {
  const input = new PassThrough(), output = new PassThrough()
  const channel = createExecutionFrameChannel({ input, output, onFrame: async () => {}, onError: () => {} })
  channel.close(); input.write('{}\n')
  await new Promise(resolve => setImmediate(resolve))
  expect(input.destroyed).toBe(false)
  input.destroy(); output.destroy()
})
it('a malformed frame reports the observation error without destroying the helper input', async () => {
  const input = new PassThrough(), output = new PassThrough()
  let rejected
  const result = new Promise(resolve => { rejected = resolve })
  createExecutionFrameChannel({ input, output, onFrame: async () => {}, onError: error => rejected(error) })
  input.write('bad\n')
  expect(await result).toBeInstanceOf(Error)
  expect(input.destroyed).toBe(false)
  input.destroy(); output.destroy()
})
