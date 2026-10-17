import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { executeSettingsControl } from '../src/main/settings-control'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import type { AppConfig } from '../src/shared/contracts'

it('actual CLI and Unix settings use the original durable owner for the Browser-only default and explicit preference', async () => {
  const cli = process.env.AGENTMUX_BROWSER_MEMORY_CLI
  expect(cli, 'Use an exact emitted original Core CLI input').toBeTypeOf('string')
  const { automaticMemoryRelease: _absent, ...browser } = structuredClone(DEFAULT_CONFIG.browser)
  const f = await configOwnerFixture({ browser })
  const directory = await mkdtemp(join(tmpdir(), 'browser-memory-settings-'))
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw Error('Unexpected business operation')
    return executeSettingsControl(request, f.owner)
  } })
  const run = async (...args: string[]) => {
    const result = await promisify(execFile)(process.execPath, [cli!, 'settings', ...args], {
      timeout: 5000, env: { ...process.env, AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path }
    })
    if (process.env.AGENTMUX_BROWSER_MEMORY_FACTS) appendFileSync(process.env.AGENTMUX_BROWSER_MEMORY_FACTS,
      JSON.stringify({ consumer: 'original-cli-unix-settings', args, stdout: result.stdout, stderr: result.stderr }) + '\n')
    return JSON.parse(result.stdout).result
  }
  try {
    await server.start()
    const initial = await f.bytes(), current = f.owner.current
    const entry = { key: 'browser.automaticMemoryRelease', kind: 'boolean', value: true, default: true }
    const inspected = run('inspect', entry.key)
    await expect(inspected).resolves.toHaveProperty('entries')
    expect((await inspected).entries).toEqual([entry])
    expect((await run('set', entry.key, 'true')).entry).toEqual(entry)
    expect(await f.bytes()).toBe(initial); expect(f.owner.current).toBe(current); expect(f.save).not.toHaveBeenCalled()
    expect((await run('set', entry.key, 'false')).entry).toEqual({ ...entry, value: false })
    expect((await f.disk()).browser.automaticMemoryRelease).toBe(false)
    expect(f.owner.current.browser.agentAutomation).toBe(browser.agentAutomation)
    expect(f.publish).toHaveBeenCalledTimes(1)
    await expect(run('set', entry.key, 'FALSE')).rejects.toMatchObject({ code: 1 })
    expect(f.publish).toHaveBeenCalledTimes(1)
    expect((await run('inspect', 'browser')).entries).toContainEqual({ ...entry, value: false })

    const before = structuredClone(f.owner.current)
    await f.owner.update(value => ({ ...value, browser: { ...value.browser, agentAutomation: true } }))
    await f.owner.edit(before, { ...before, browser: { ...before.browser, automaticMemoryRelease: true } })
    expect(f.owner.current.browser).toMatchObject({ agentAutomation: true, automaticMemoryRelease: true })
    const { automaticMemoryRelease: _previous, ...implicitBrowser } = before.browser
    const stale = { ...before, browser: implicitBrowser }
    await expect(f.owner.edit(stale, { ...stale, browser: { ...browser, automaticMemoryRelease: false } })).resolves.toBeDefined()
    expect(f.owner.current.browser.automaticMemoryRelease).toBe(false)
    const invalid: unknown = { ...f.owner.current, browser: { ...browser, automaticMemoryRelease: 'false' } }
    expect(() => f.store.validate(invalid as AppConfig)).toThrow()
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
})
