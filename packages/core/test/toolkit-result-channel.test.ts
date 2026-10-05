import { afterEach, expect, it } from 'vitest'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { stat } from 'node:fs/promises'
import { openToolkitResultChannel, connectToolkitResultChannel } from '../src/toolkit-result-channel.js'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
it('authenticates one dedicated stream, preserves bytes/backpressure and removes its capability', async () => {
 let resume!: () => void, started!: () => void
 const blocked = new Promise<void>(resolve => { resume = resolve }), reading = new Promise<void>(resolve => { started = resolve })
 const chunks: Uint8Array[] = [], failures: unknown[] = []
 const channel = await openToolkitResultChannel({ onBytes: async bytes => { started(); await blocked; chunks.push(bytes) }, onEnd() {}, onError: e => failures.push(e) })
 cleanup.push(channel.close)
 expect((await stat(channel.env.AGENTMUX_TOOLKIT_RESULT_PATH)).mode & 0o777).toBe(0o600)
 const env = { ...channel.env }, socket = await connectToolkitResultChannel(env)
 expect(env).toEqual({});socket.write('first');await reading;expect(chunks).toEqual([])
 resume();socket.end('second');await once(socket,'close')
 expect(Buffer.concat(chunks).toString()).toBe('firstsecond');expect(failures).toEqual([])
 await channel.close();await expect(stat(channel.env.AGENTMUX_TOOLKIT_RESULT_PATH)).rejects.toMatchObject({code:'ENOENT'})
})
it('rejects arbitrary/oversized and old credentials without accepting a machine result', async () => {
 const chunks: Uint8Array[] = [], failures: unknown[] = []
 const channel = await openToolkitResultChannel({onBytes: bytes => {chunks.push(bytes)},onEnd(){},onError:e=>failures.push(e)})
 cleanup.push(channel.close)
 for(const header of ['0'.repeat(64)+'\n{"valid":"JSON"}\n','x'.repeat(1024)]) {
  const socket=createConnection(channel.env.AGENTMUX_TOOLKIT_RESULT_PATH);socket.on('error',()=>{});await once(socket,'connect');socket.resume();socket.end(header);await once(socket,'close')
 }
 expect(chunks).toEqual([])
 await expect(connectToolkitResultChannel({...channel.env,AGENTMUX_TOOLKIT_RESULT_TOKEN:'0'.repeat(64)})).rejects.toMatchObject({code:'TOOLKIT_RESULT_CHANNEL_FAILED'})
 const socket=await connectToolkitResultChannel({...channel.env});socket.end('actual');await once(socket,'close')
 expect(Buffer.concat(chunks).toString()).toBe('actual');expect(failures).toEqual([])
 // One accepted stream cannot reconnect and substitute a later producer.
 const late=createConnection(channel.env.AGENTMUX_TOOLKIT_RESULT_PATH);late.on('error',()=>{});await once(late,'connect');late.resume();late.end(channel.env.AGENTMUX_TOOLKIT_RESULT_TOKEN+'\nlate');await once(late,'close')
 expect(Buffer.concat(chunks).toString()).toBe('actual')
})
it('never substitutes stdout when no exact capability exists',async()=>{
 await expect(connectToolkitResultChannel({})).rejects.toMatchObject({code:'TOOLKIT_RESULT_CHANNEL_FAILED'})
})
