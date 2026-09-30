import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../../../packages/core/src/control.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { resolvePerformancePreferences } from '../src/shared/toolkit-preferences.js'

const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'toolkit-preferences' } as const

describe('Toolkit preferences on the unique durable owner', () => {
  it.each([undefined, {}, { performance: {} }, { performance: { enabled: true } }, { performance: { statusBar: 'icon' as const } }])('keeps absent defaults absent and no-op saves silent: %j', async toolkit => {
    const f = await configOwnerFixture(toolkit === undefined ? {} : { toolkit })
    const original = await f.bytes()
    const prefs = resolvePerformancePreferences(f.owner.current)
    expect(prefs).toEqual({ enabled: true, statusBar: 'icon' })
    const get = await executeSettingsControl({ ...envelope, operation: 'settings.get', target: 'toolkit' }, f.owner)
    expect(get).toMatchObject({ entries: [
      { key: 'toolkit.performance.enabled', value: true }, { key: 'toolkit.performance.statusBar', value: 'icon' }
    ] })
    for (const [key, value] of [['enabled','true'], ['statusBar','icon']]) {
      await executeSettingsControl({ ...envelope, operation: 'settings.set', key: `toolkit.performance.${key}`, value: value! }, f.owner)
    }
    await f.owner.edit({ ...f.owner.current, toolkit: { performance: prefs } }, { ...f.owner.current, toolkit: { performance: prefs } })
    expect(await f.bytes()).toBe(original)
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.runtime.prepare).not.toHaveBeenCalled()
    const current = f.owner.current
    const saved = await f.owner.edit({ ...current, toolkit: { performance: prefs } }, { ...current, toolkit: { performance: { ...prefs, enabled: false } } }).catch(error => error)
    expect(saved).toMatchObject({ toolkit: { performance: { enabled: false } } })
    expect(resolvePerformancePreferences(f.owner.current)).toEqual({ enabled: false, statusBar: 'icon' })
    expect(await f.disk()).toEqual(f.owner.current)
    expect(f.owner.current.executors).toEqual(current.executors)
    expect(f.owner.current.workspaces).toEqual(current.workspaces)
    expect(f.owner.current.hosts).toEqual(current.hosts)
  })
  it('preserves a concurrent unauthored sibling and accepts an already applied authored value', async () => {
    const f = await configOwnerFixture()
    const before = { ...f.owner.current, toolkit: { performance: { enabled: true, statusBar: 'icon' as const } } }
    const after = { ...before, toolkit: { performance: { enabled: false, statusBar: 'icon' as const } } }
    await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'toolkit.performance.statusBar', value: 'label' }, f.owner)
    await f.owner.edit(before, after)
    expect(resolvePerformancePreferences(f.owner.current)).toEqual({ enabled: false, statusBar: 'label' })
    const bytes = await f.bytes(), count = f.publish.mock.calls.length
    await f.owner.edit(before, after)
    expect(await f.bytes()).toBe(bytes)
    expect(f.publish).toHaveBeenCalledTimes(count)
  })
  it('rejects bad scalar values and unknown nested settings without changing the config', async () => {
    const f = await configOwnerFixture(), original = await f.bytes()
    for (const [key,value] of [['enabled','1'], ['statusBar','metrics']]) {
      await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key: `toolkit.performance.${key}`, value: value! }, f.owner)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    }
    expect(() => f.store.validate({ ...f.owner.current, toolkit: { performance: { command: 'anything' } } })).toThrow()
    expect(await f.bytes()).toBe(original)
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.runtime.prepare).not.toHaveBeenCalled()
  })
  it('the actual compiled CLI reads and writes the same registered owner and disk', async () => {
    const f = await configOwnerFixture()
    const directory = await mkdtemp(join(tmpdir(), 'am-toolkit-prefs-'))
    const cli = process.env.AGENTMUX_TOOLKIT_PREFERENCES_CLI
    expect(cli, 'Owning verifier must compile the actual CLI').toBeTruthy()
    const server = new AgentMuxControlServer({ execute: async request => {
      if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Unexpected operation')
      return executeSettingsControl(request, f.owner)
    } }, join(directory,'control.sock'))
    const run = async (args: string[]) => {
      const child = spawn(process.execPath, [cli!, 'settings', ...args], { env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: directory }, stdio: ['ignore','pipe','pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
      const code = await new Promise(resolve => child.once('close',resolve))
      const frames = (stdout+stderr).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      expect(frames).toHaveLength(1)
      return { code, frame: frames[0] }
    }
    await server.start()
    try {
      const initial = await run(['get','toolkit'])
      expect(initial).toMatchObject({ code: 0, frame: { ok: true, result: { entries: [
        { key:'toolkit.performance.enabled',value:true }, { key:'toolkit.performance.statusBar',value:'icon' }
      ] } } })
      expect(await run(['set','toolkit.performance.statusBar','label'])).toMatchObject({ code:0, frame:{ok:true,result:{entry:{value:'label'}}} })
      expect(resolvePerformancePreferences(await f.disk())).toEqual({enabled:true,statusBar:'label'})
      expect(await run(['set','toolkit.performance.enabled','false'])).toMatchObject({ code:0,frame:{ok:true} })
      const original=await f.bytes()
      expect(await run(['set','toolkit.performance.statusBar','bad'])).toMatchObject({code:1,frame:{ok:false,error:{code:'INVALID_SETTING_VALUE'}}})
      expect(await f.bytes()).toBe(original)
      expect(resolvePerformancePreferences(await f.disk())).toEqual({enabled:false,statusBar:'label'})
    } finally { await server.stop(); await rm(directory,{recursive:true,force:true}) }
  })
})
