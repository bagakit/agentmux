// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { connectRelayHostedClient } from '../../../packages/core/src/relay-hosted.js'
import { readResolvedTheme } from '@agentmux/client-ui/theme'
import { useHostAppearance } from '../../mobile/src/appearance/useHostAppearance.js'
import { useMobileCommands } from '../../mobile/src/conversation/use-mobile-commands.js'
import { until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { mobileWebFixture } from './helpers/mobile-web-fixture.js'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const WebSocket = createRequire(join(process.cwd(), 'packages/relay/package.json'))('ws')
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })

it('real Mobile Commands and appearance readers use the original Host after Desktop exits and converge after metadata failure', async () => {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', join(process.cwd(), 'packages/core/bin/amux'))
  const f = await mobileWebFixture(); cleanup.push(f.close)
  const configurationPath = join(dirname(f.native.env.AGENTMUX_AGENT_SESSION_STORE!), 'original-configuration.json')
  const configuration = JSON.parse(await readFile(configurationPath, 'utf8'))
  configuration.composerShortcuts = [{ id: 'original-command', keyword: 'original', label: 'Original Command', body: 'Original shared prompt text', providerId: 'codex' }]
  configuration.appearance = { themeId: 'graphite', appAppearance: 'light', terminalTheme: 'graphite' }
  const save = async (next: unknown) => { await writeFile(configurationPath + '.next', JSON.stringify(next)); await rename(configurationPath + '.next', configurationPath) }
  await save(configuration)
  await f.startMain(); await f.stopMain()
  const connection = new AbortController()
  const phone = await connectRelayHostedClient({ offer: f.info.offer, name: 'Private original Mobile', signal: connection.signal, createWebSocket: url => new WebSocket(url) })
  cleanup.push(async () => { connection.abort(); await phone.dispose() })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); cleanup.push(async () => { await act(async () => root.unmount()); container.remove() })
  let commands: ReturnType<typeof useMobileCommands> | undefined, appearance: ReturnType<typeof useHostAppearance> | undefined
  function MobileReaders() {
    commands = useMobileCommands({ client: phone, agentSessionId: f.session.agentSessionId, providerId: 'codex', commands: [], visible: true, connected: true, demand: true })
    appearance = useHostAppearance(phone, 'connected')
    return null
  }
  await act(async () => { root.render(<MobileReaders />) })
  await expect(until(async () => { await act(async () => {}); return commands?.commands ?? [] }, values => values.some(value => value.text === '/original'), 'the actual Mobile Commands reader receives original saved Commands')).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ text: '/original' })]))
  await expect(until(async () => { await act(async () => {}); if (appearance?.issue) throw new Error(appearance.issue); return appearance?.terminalPalette }, value => value?.background === '#000000', 'the actual Mobile appearance reader opens without Desktop')).resolves.toMatchObject({ background: '#000000' })
  expect(readResolvedTheme().mode).toBe('light')
  const resources = await phone.forwardRpc('settings.executors.ls', {})
  expect(resources.items).toMatchObject([{ id: 'codex', value: { label: 'Original Codex', providerId: 'codex' } }])
  expect((await phone.forwardRpc('settings.prompts.inspect', { keyword: 'original' })).item).toMatchObject({ id: 'original-command', value: { body: 'Original shared prompt text' } })
  expect((await phone.forwardRpc('settings.themes.inspect', { id: 'graphite' })).item.id).toBe('graphite')
  configuration.appearance.terminalTheme = 'dracula'; configuration.appearance.appAppearance = 'dark'
  await save(configuration)
  await expect(until(async () => { await act(async () => {}); return appearance?.terminalPalette }, value => value?.background === '#282a36', 'an atomic original configuration update reaches the same Mobile reader')).resolves.toMatchObject({ background: '#282a36', blue: '#bd93f9' })
  await writeFile(configurationPath, '{')
  await expect(until(async () => { await act(async () => {}); return appearance?.issue }, value => Boolean(value), 'the metadata failure is visible on the actual Mobile reader')).resolves.toEqual(expect.any(String))
  expect(appearance?.terminalPalette?.background).toBe('#282a36')
  expect((await phone.statusAgent(f.session.agentSessionId)).run.state).toBe('running')
  configuration.appearance.terminalTheme = 'nord'
  await save(configuration)
  await expect(until(async () => { await act(async () => {}); return { palette: appearance?.terminalPalette, issue: appearance?.issue } }, value => value.palette?.background === '#2e3440' && value.issue === null, 'the same Mobile reader clears the issue after original metadata recovers')).resolves.toMatchObject({ palette: { background: '#2e3440' }, issue: null })
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.native.socketPath, 'settings', 'prompts', 'ls'], f.native.env)
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.items[0].id).toBe('original-command')
  expect(JSON.parse(await readFile(configurationPath, 'utf8'))).toEqual(configuration)
}, 120_000)
