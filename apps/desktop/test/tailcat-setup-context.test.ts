import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostConfig } from '../src/shared/contracts'
import { createTailcatSetupTask, tailcatSetupContext, tailcatSetupPrompt } from '../src/renderer/src/lib/tailcat-setup-task'

const fixture = vi.hoisted(() => ({ hosts: [] as unknown[], inspect: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: { getState: () => ({ config: { hosts: fixture.hosts } }) } }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { hosts: { inspect: fixture.inspect } } }))

const local: HostConfig = { id: 'local', kind: 'local', label: 'This Mac' }
const destination: HostConfig = { id: 'other-mac', kind: 'ssh', label: 'Other Mac', hostname: '', transport: 'tailcat',
  runtimeId: 'destination-runtime', identityFile: '/private/ssh-canary', remoteCommand: 'sensitive-command-canary',
  tailcat: { address: 'tcPrivateDestinationCanary', keyFile: '/private/client-canary.private.json' } }

beforeEach(() => { fixture.hosts = [local, destination]; fixture.inspect.mockReset() })
afterEach(() => { vi.restoreAllMocks() })

describe('Tailcat help retains the exact Mac without forwarding its credentials', () => {
  it('copies only field presence from either side, never a private value or whole Host', () => {
    const receiver: HostConfig = { ...local, tailcat: { enabled: true, keyFile: '/private/server-canary.private.json',
      allowedClients: ['nodekey:public-client-canary'] } }
    const client = tailcatSetupPrompt(tailcatSetupContext(destination, 'client'), null)
    const server = tailcatSetupPrompt(tailcatSetupContext(receiver, 'server'), null)
    for (const privateValue of [destination.tailcat!.address, destination.tailcat!.keyFile, destination.identityFile!,
      destination.remoteCommand!, receiver.tailcat!.keyFile, receiver.tailcat!.allowedClients[0]!]) {
      expect(client + server).not.toContain(privateValue)
    }
    expect(client).toContain('other-mac')
    expect(client).toContain('"privateDestinationFieldFilled": true')
    expect(server).toContain('"allowedClientsFieldFilled": true')
    expect(client).toContain('saving and application are not confirmed')
  })

  it('identifies the Desktop local owner, independently of the remote Host being edited', async () => {
    fixture.inspect.mockResolvedValue({ routeHostId: 'local', configuration: local,
      owner: { state: 'available', value: { runtimeId: 'desktop-original-runtime' } } })
    const context = tailcatSetupContext(destination, 'client')
    expect(fixture.inspect).not.toHaveBeenCalled()
    const task = await createTailcatSetupTask(context)
    expect(fixture.inspect).toHaveBeenCalledExactlyOnceWith(local)
    expect(task).toContain('desktop-original-runtime')
    expect(task).not.toContain('destination-runtime')
    expect(task).not.toContain('tcPrivateDestinationCanary')
    expect(task).toContain('brew install tailcat')
    expect(task).toContain('Another device')
  })

  it('keeps help available when the target owner cannot be read', async () => {
    fixture.inspect.mockRejectedValue(new Error('credential-canary-from-original-error'))
    const task = await createTailcatSetupTask(tailcatSetupContext(destination, 'client'))
    expect(task).toContain('Runtime ID is unconfirmed')
    expect(task).not.toContain('credential-canary-from-original-error')
    expect(task).toContain('do not install on your own local by assumption')
  })

  it('carries the known preparation step and settings target without a raw failure or secret', () => {
    const context = tailcatSetupContext(destination, 'client', { step: 'prepare-key', code: 'RPC_METHOD_NOT_FOUND' })
    expect(context.failure).toEqual({ step: 'prepare-key', code: 'RPC_METHOD_NOT_FOUND' })
    expect(context.settingsTarget).toEqual({ section: 'hosts', hostId: 'other-mac', item: 'connection' })
    const task = tailcatSetupPrompt(context, 'desktop-original-runtime')
    expect(task).toContain('check that service before any CLI installation')
    expect(task).not.toContain('tcPrivateDestinationCanary')
    const receiver = tailcatSetupContext(local, 'server', { step: 'prepare-key', code: null })
    expect(receiver.settingsTarget).toEqual({ section: 'network-node', hostId: 'local', item: 'incoming' })
    expect(receiver.failure?.code).toBeNull()
  })

  it('rejects a foreign route while keeping the local owner across unrelated label edits', async () => {
    fixture.inspect.mockResolvedValue({ routeHostId: 'other-mac', configuration: local,
      owner: { state: 'available', value: { runtimeId: 'foreign-owner-canary' } } })
    expect(await createTailcatSetupTask(tailcatSetupContext(local, 'server'))).not.toContain('foreign-owner-canary')
    fixture.inspect.mockImplementation(async () => {
      fixture.hosts = [{ ...local, label: 'Changed while reading' }]
      return { routeHostId: 'local', configuration: local, owner: { state: 'available', value: { runtimeId: 'known-local-owner' } } }
    })
    expect(await createTailcatSetupTask(tailcatSetupContext(local, 'server'))).toContain('known-local-owner')
    fixture.inspect.mockResolvedValue({ routeHostId: 'local', configuration: null,
      owner: { state: 'available', value: { runtimeId: 'known-owner-configuration-unknown' } } })
    expect(await createTailcatSetupTask(tailcatSetupContext(local, 'server'))).toContain('known-owner-configuration-unknown')
  })
})
