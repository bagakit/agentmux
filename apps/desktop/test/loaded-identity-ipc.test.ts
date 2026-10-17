import { expect, it } from 'vitest'
import { registerLoadedIdentityIpc } from '../src/main/client-observation'
import { senderTrust, assertSenderTrusted } from '../src/main/ipc-sender-trust'

it('projects only the actual loaded owners through the original trusted registration', () => {
  const sender = {}, handlers = new Map<string, (event: any) => any>()
  const p = { schema: 'agentmux.package-identity.v1' as const, sourceCommit: 'loaded-source', sourceTree: 'loaded-tree', appVersion: '1', platform: 'darwin', arch: 'arm64', rawPrivate: 'private package fields' }
  let r: { kind: 'bundled' | 'staged'; id: string; identity: { shell: string; ctxmux: string }; privateField: string } | null = { kind: 'bundled', id: 'a'.repeat(64), identity: { shell: 'loaded-shell', ctxmux: 'loaded-native' }, privateField: 'private renderer fields' }
  registerLoadedIdentityIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: (channel, event) => assertSenderTrusted(senderTrust(channel, event.sender, sender)), package: p, renderer: () => r })
  const read = () => handlers.get('ui:readLoadedIdentity')!({ sender })
  expect(read()).toEqual({ package: { schema: p.schema, sourceCommit: 'loaded-source', sourceTree: 'loaded-tree', appVersion: '1', platform: 'darwin', arch: 'arm64' }, renderer: { kind: 'bundled', id: 'a'.repeat(64), identity: { shell: 'loaded-shell', ctxmux: 'loaded-native' } } })
  expect(() => handlers.get('ui:readLoadedIdentity')!({ sender: {} })).toThrow('Untrusted loaded application identity sender')
  r = { kind: 'staged', id: 'b'.repeat(64), identity: { shell: 'loaded-shell', ctxmux: 'loaded-native' }, privateField: 'private' }
  expect(read().renderer.id).toBe('b'.repeat(64))
  r = null
  expect(read()).toEqual({ package: { schema: p.schema, sourceCommit: 'loaded-source', sourceTree: 'loaded-tree', appVersion: '1', platform: 'darwin', arch: 'arm64' }, renderer: null })
})
