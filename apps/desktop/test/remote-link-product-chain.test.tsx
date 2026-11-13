// @vitest-environment happy-dom
import { act } from 'react'
import { EventEmitter } from 'node:events'
import { writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { headlessFixture } from '../../../packages/core/test/helpers/headless-runtime-fixture'
import { connectDesktopAgentMuxHost } from '../src/main/desktop-host'
import { RuntimeController } from '../src/main/runtime-controller'
import { HostBadge } from '../src/renderer/src/components/HostBadge'
import { hostIdentityProjection } from '../src/renderer/src/lib/region-execution-host'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { AppConfig, RuntimeEvent, SshHostConfig } from '../src/shared/contracts'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()

it('carries actual SSH from the original Desktop connector through Main snapshot/events and Store into a passive HostBadge', async () => {
  const scope = await headlessFixture()
  const controller = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), connectDesktopAgentMuxHost)
  let detach = () => {}
  try {
    const methods = join(scope.root, 'carrier-methods'), launches = join(scope.root, 'carrier-launches')
    await writeFile(methods, ''); await writeFile(launches, '')
    const forward = pathToFileURL(resolve(import.meta.dirname, '../../../packages/core/dist/agentmux-rpc-stdio.js')).href
    // Only SSH's executable/stdio boundary is controlled. The connector, selected
    // carrier, separate semantic Core/ctxmux, Main projection and UI are original.
    await writeFile(join(scope.root, 'ssh'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { forwardAgentMuxRpcStdio } from ${JSON.stringify(forward)};
appendFileSync(${JSON.stringify(launches)}, 'ssh\\n');
let buffered='';
const input=new Transform({transform(bytes,_encoding,done){
 buffered+=bytes.toString();let newline;
 while((newline=buffered.indexOf('\\n'))>=0){const line=buffered.slice(0,newline);buffered=buffered.slice(newline+1);if(line)appendFileSync(${JSON.stringify(methods)},JSON.parse(line).method+'\\n');}
 done(null,bytes);
}});
process.stdin.pipe(input);
await forwardAgentMuxRpcStdio({endpoint:{transport:'unix',path:${JSON.stringify(scope.socketPath)}},input,output:process.stdout});
`, { mode: 0o700 })
    vi.stubEnv('PATH', `${scope.root}:${process.env.PATH}`)
    const host: SshHostConfig = { id: 'private-chain', kind: 'ssh', label: 'Private product chain', hostname: 'private-product-chain.fixture',
      runtimeId: scope.owner.runtimeId, remoteSocketPath: scope.socketPath, transport: 'ssh-tailcat',
      tailcat: { address: 'tcSynthetic_ProductChainCredential', keyFile: 'saved-product-chain-client' } }
    const config: AppConfig = { ...structuredClone(composerConfig), hosts: [host], executors: {}, workspaces: [] }
    useAppStore.setState({ config })
    expect(useAppStore.getState().hostTransports?.[host.id]).toBeUndefined()
    const originalDraft = useAppStore.getState().agentComposerDrafts['agent-1']
    let inFlight = 0
    const snapshot = vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => {
      inFlight++
      try { return await controller.snapshot(config) } finally { inFlight-- }
    })
    const sent: RuntimeEvent[] = []
    const sender = Object.assign(new EventEmitter(), { id: 7331, isDestroyed: () => false,
      send: (_channel: string, event: RuntimeEvent) => { sent.push(event); useAppStore.getState().applyEvent(event) } })
    detach = controller.attach(sender as never)
    const prepared = await controller.prepare(config)
    controller.validatePreparation(prepared); controller.commit(prepared)
    await controller.rpcClients()[0]!.client.connect()
    await vi.waitFor(() => {
      expect(snapshot).toHaveBeenCalled()
      expect(inFlight).toBe(0)
      expect(useAppStore.getState().hostTransports?.[host.id]).toMatchObject({ state: 'connected', transport: 'ssh', fallback: false, establishedAt: expect.any(Number) })
    })
    expect(sent.some(event => event.hostId === host.id && event.hostTransport?.state === 'connected' && event.hostTransport.transport === 'ssh')).toBe(true)
    expect((await controller.snapshot(config)).hostTransports?.[host.id]).toMatchObject({ state: 'connected', transport: 'ssh', fallback: false })
    const inspect = vi.spyOn(api.hosts, 'inspect'), home = vi.spyOn(api.hosts, 'home')
    const check = vi.spyOn(api.hosts, 'check'), network = vi.spyOn(api.hosts, 'network'), originalAction = vi.fn()
    await dom.render(<button type="button" onClick={originalAction}>Original action<HostBadge context="Host" host={hostIdentityProjection(host.id, host)} /></button>)
    const badge = dom.container.querySelector<HTMLElement>('[data-host-id]')!, action = dom.container.querySelector<HTMLButtonElement>('button')!
    const callsBeforeHover = await readFile(methods, 'utf8'), snapshotsBeforeHover = snapshot.mock.calls.length
    await act(async () => badge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Current: SSH · Channel connected')
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Saved preference: SSH first, Tailcat backup')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => action.focus())
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(host.id)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Current: SSH')
    await act(async () => action.click())
    expect(originalAction).toHaveBeenCalledTimes(1)
    expect(inspect).not.toHaveBeenCalled(); expect(home).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled()
    expect(snapshot).toHaveBeenCalledTimes(snapshotsBeforeHover)
    expect(await readFile(methods, 'utf8')).toBe(callsBeforeHover)
    expect((await readFile(launches, 'utf8')).trim().split('\n')).toEqual(['ssh'])
    expect(useAppStore.getState().agentComposerDrafts['agent-1']).toBe(originalDraft)
    expect(document.body.innerHTML).not.toContain(host.tailcat!.address)
  } finally {
    detach()
    await controller.dispose()
    await scope.cleanup()
    vi.unstubAllEnvs()
  }
}, 30_000)
