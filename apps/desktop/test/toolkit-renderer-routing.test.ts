// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'

it('actual Renderer control consumer rejects all Main-owned Toolkit operations before touching its workspace or execution API',async()=>{
  const before=useAppStore.getState()
  const run=vi.spyOn(api.toolkit,'run')
  const stop=vi.spyOn(api.toolkit,'stop')
  const observe=vi.spyOn(api.toolkit,'observe')
  const results:string[]=[]
  try {
    for(const operation of ['toolkit.list','toolkit.get','toolkit.script','toolkit.run','toolkit.stop','toolkit.watch'] as const) {
      await expect(useAppStore.getState().executeControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId:operation,operation,toolId:'performance'})).rejects.toMatchObject({code:'CONTROL_FAILED',
          message:'Toolkit requests belong to the Main execution owner.'})
      results.push(operation)
    }
    expect(results).toEqual(['toolkit.list','toolkit.get','toolkit.script','toolkit.run','toolkit.stop','toolkit.watch'])
    expect(useAppStore.getState()).toBe(before)
    expect(run).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled();expect(observe).not.toHaveBeenCalled()
  } finally {vi.restoreAllMocks()}
})
