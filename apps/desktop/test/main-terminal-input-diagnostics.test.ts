import { expect, it, vi } from 'vitest'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
const flush = async () => { for(let i=0;i<20;i++) await Promise.resolve() }
it('actual Main write/paste keeps FIFO, cursor/error semantics and distinct queued/status/native phases', async () => {
  const connect = vi.fn(async () => { throw new Error('No connection should be opened') })
  const owner = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), connect)
  let status!: () => void, native!: () => void, accepted = 0
  const waitingStatus = new Promise<void>(resolve => { status = resolve }), waitingNative = new Promise<void>(resolve => { native = resolve })
  const sent: Array<{ expectedByte:number; data:string }> = [], failure = new Error('original native failure')
  const client = { listRuns: async () => { await waitingStatus; return [{runId:'synthetic-run',acceptedInputBytes:accepted}] },
    runtimeIdentity:()=>({instanceId:'synthetic-owner'}), writeTerminal:async (_run:unknown,input:{expectedByte:number;data:string}) => {
      sent.push(input);if(sent.length===1) await waitingNative
      if(input.data==='failure') throw failure
      expect(input.expectedByte).toBe(accepted);accepted+=Buffer.byteLength(input.data)
      return {acceptedThroughByte:accepted}
    } }
  const inner = owner as any
  inner.connectedClient = async () => client // Controlled existing connection seam; product write and FIFO execute unchanged.
  const control = {kind:'terminal' as const,hostId:'local',runId:'synthetic-run',run:{runId:'synthetic-run'}}
  const snapshot = async () => (await owner.performanceDiagnostics(new AbortController().signal)).main.input
  try {
    const one = owner.write(control,'first','user'),two = owner.paste(control,'paste','\u001b[200~paste\u001b[201~')
    await flush()
    expect((await snapshot()).active.map(value=>value.stage)).toEqual(['current-run','queued'])
    expect(sent).toEqual([]);status();await flush()
    expect((await snapshot()).active[0]?.stage).toBe('native-input')
    native();await Promise.all([one,two])
    expect(sent.map(value=>value.data)).toEqual(['first','\u001b[200~paste\u001b[201~'])
    await expect(owner.write(control,'failure','user')).rejects.toBe(failure)
    expect(await snapshot()).toMatchObject({started:3,completed:2,failed:1,pending:0,kinds:{terminal:3},
      currentRun:{count:1},nativeInput:{count:3}})
    expect((await snapshot()).recent.at(-1)?.stage).toBe('native-input')
    expect(inner.terminalInputTails.size).toBe(0);expect(inner.terminalInputCursors.size).toBe(0)
    expect(connect).not.toHaveBeenCalled()
  } finally { status();native();owner.resourceSampler.dispose() }
})
