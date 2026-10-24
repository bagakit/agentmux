// @vitest-environment happy-dom
import { act } from 'react'
import { join, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc, type AgentMuxRpcClient } from '../../../packages/core/src/public-rpc-client.js'
import type { AgentMuxControlRequest } from '../../../packages/core/src/control.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { executeSettingsResourcesControl } from '../src/main/settings-resources-control.js'
import { ConfigStore } from '../src/main/config-store.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { MobileConversationSurface } from '../../mobile/src/conversation/MobileConversationSurface.js'
import { createBrowserPlatform } from '../../mobile/src/platform/browser.js'
import { emptyDeviceWorkface, getDeviceWorkface } from '../../mobile/src/recovery/device-workface.js'
import { button, click, editor, fixture, mount, mounted, paste } from '../../mobile/test/conversation-fixture.js'

vi.mock('electron', async () => { const { tmpdir } = await import('node:os'); return { app: { getPath: () => tmpdir() } } })

beforeEach(async () => {
  localStorage.clear()
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => {
  for (const item of mounted.splice(0)) {
    await act(async () => item.root.unmount())
    item.element.remove()
  }
})

it('the executable CLI and mounted mobile Commands share the original durable prompt owner', async () => {
  const prompts = [
    { id: 'global-review', keyword: 'review-original', label: '原配置独立复核', body: '保留 $TOKEN\n逐项检查原始证据。' },
    { id: 'codex-review', keyword: 'review-codex', label: 'Codex 原配置', body: '只用于 Codex。', providerId: 'codex' },
    { id: 'claude-review', keyword: 'review-claude', label: '另一个 Provider 的配置', body: '只用于 Claude。', providerId: 'claude' }
  ]
  const config = await configOwnerFixture({ composerShortcuts: prompts })
  // A short, private Unix path avoids depending on the host's long temporary directory.
  const directory = await mkdtemp('/tmp/am-mobile-prompts-')
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve(import.meta.dirname, '../../../packages/core/bin/amux'))
  const seen: AgentMuxControlRequest[] = []
  const server = new AgentMuxControlServer({ coreClients: () => [], socketPath: join(directory, 'rpc.sock'),
    execute: request => {
      seen.push(request)
      switch (request.operation) {
        case 'settings.resource.list': case 'settings.resource.get': case 'settings.resource.add':
        case 'settings.resource.update': case 'settings.resource.remove':
          return executeSettingsResourcesControl(request, config.owner)
        default: throw new Error('The prompt reader cannot borrow another product operation.')
      }
    }
  })
  let rpc: AgentMuxRpcClient | undefined
  const cli = async (...parts: string[]) => {
    const result = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, 'settings', 'prompts', ...parts], objectCliEnvironment(directory))
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    const receipt = JSON.parse(result.stdout)
    expect(receipt.ok).toBe(true)
    return receipt.result
  }
  try {
    await server.start()
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const expectedItems = prompts.map(({ id, ...value }) => ({ id, value }))
    expect(await cli('ls')).toEqual({ resource: 'prompts', items: expectedItems, partial: true })
    expect(await rpc.call('settings.prompts.ls', {})).toEqual({ resource: 'prompts', items: expectedItems, partial: true })
    const bytes = await config.bytes()
    const f = fixture()
    const forwardRpc = vi.fn(rpc.call.bind(rpc))
    Object.assign(f.client, { forwardRpc })
    const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '原 Host' }} platform={createBrowserPlatform()} />)
    await paste(view.element, '保留原草稿 ')
    const originalEditor = editor(view.element)
    expect(forwardRpc).not.toHaveBeenCalled()
    await click(button(view.element, 'Choose a command'))
    expect(forwardRpc).toHaveBeenCalledTimes(1)
    await act(async () => { await forwardRpc.mock.results.at(-1)!.value })
    expect(forwardRpc.mock.calls).toEqual([['settings.prompts.ls', {}, { signal: expect.any(AbortSignal) }]])
    const menu = document.querySelector('.mobile-command-menu')!
    expect(menu.textContent).toContain('Shortcuts')
    expect(menu.textContent).toContain('Agent commands')
    expect(menu.textContent).toContain(prompts[1]!.label)
    expect(menu.textContent).not.toContain(prompts[2]!.label)
    const select = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find(item => item.querySelector('strong')?.textContent === prompts[0]!.label)
    expect(select, 'The actual mounted item comes from the original ConfigOwner').toBeDefined()
    await click(select!)
    expect(editor(view.element)).toBe(originalEditor)
    expect(originalEditor.textContent).toContain('保留原草稿')
    expect(originalEditor.querySelector('[data-tool-reference="subcommand"]')?.getAttribute('title'))
      .toBe(`Expand prompt: ${prompts[0]!.body}`)
    expect(f.submit).not.toHaveBeenCalled()
    expect(await config.bytes()).toBe(bytes)

    // Deleting the original settings through the CLI is visible on the next explicit open.
    for (const prompt of prompts) expect(await cli('delete', prompt.id)).toMatchObject({ id: prompt.id, removed: true })
    expect((await new ConfigStore(config.store.filePath).get()).composerShortcuts).toEqual([])
    expect(await cli('ls')).toEqual({ resource: 'prompts', items: [], partial: true })
    await click(button(view.element, 'Choose a command'))
    expect(forwardRpc).toHaveBeenCalledTimes(2)
    await act(async () => { await forwardRpc.mock.results.at(-1)!.value })
    expect(document.querySelector('.mobile-command-menu')?.textContent).not.toContain(prompts[0]!.label)
    expect(document.querySelector('.mobile-command-menu [role=group][aria-label="Agent commands"]')).not.toBeNull()
    expect(document.querySelector('.mobile-command-menu')?.textContent).not.toContain(prompts[1]!.label)
    expect(f.submit).not.toHaveBeenCalled()
    expect(editor(view.element)).toBe(originalEditor)
    expect(originalEditor.textContent).toContain('保留原草稿')
    expect(seen.filter(request => request.operation === 'settings.resource.list')).toHaveLength(5)
    expect(seen.every(request => 'resource' in request && request.resource === 'prompts')).toBe(true)
  } finally {
    await rpc?.dispose()
    await server.stop()
    await rm(directory, { recursive: true, force: true })
    vi.unstubAllEnvs()
  }
}, 30_000)
