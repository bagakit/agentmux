import { act } from 'react'
import { webcrypto } from 'node:crypto'
import { dirname, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { createMoteConversationStartFixture } from '../../host/test/helpers/mote-conversation-start-fixture'
import { readMoteMainAction, type MoteMainActionReading } from '../../desktop/src/renderer/src/lib/mote-main-action'
import { useAppStore } from '../../desktop/src/renderer/src/store'
import { api } from '../../desktop/src/renderer/src/lib/api'
import { MobileMoteMainActions } from '../src/navigation/MobileMoteMainActions'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { mount, mounted } from './conversation-fixture'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
const baseline = useAppStore.getState(), closes: Array<() => Promise<unknown>> = []
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  for (const close of closes.splice(0).reverse()) await close()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren()
})
// Each condition has a bounded business assertion. A deliberately pending source
// must fail this assertion, rather than turning the test into a runner timeout.
async function observe(check: () => boolean) {
  for (let n = 0; n < 75 && !check(); n++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
}
async function original() {
  const host = await createMoteConversationStartFixture(); closes.push(host.close)
  const state = (await host.rpc.call('space.state', {})).state!
  const space = state.graph.spaces.find(value => value.spaceId === host.target.spaceId)!
  const workspace = { ...host.target.expectedResource, id: host.target.expectedResource.workspaceId, path: host.target.expectedResource.workspacePath, name: 'Original', kind: 'folder' as const }
  const rootPath = relative(workspace.path, dirname(host.path))
  const scope = { workspace, rootPath, topic: { id: space.topicId!, title: 'Original', summary: '', collaborators: [],
    directoryPath: rootPath, identityDirectoryPath: space.directoryPath!, physicalDirectoryPath: dirname(host.path), topicPath: rootPath + '/topic.md' } }
  useAppStore.setState({ spaceZoneBindings: { [host.target.zoneId]: { spaceId: host.target.spaceId, workspaceId: workspace.id, topicId: scope.topic.id, contentKind: 'mote' } }, moteMainCreationReferences: {} })
  const bytes = await readFile(host.path, 'utf8')
  const catalog = vi.spyOn(host.quickPorts, 'catalog').mockImplementation(() => new Promise(() => {}))
  const executors = vi.spyOn(host.quickPorts, 'executors')
  const calls = vi.fn((method: any, input: any) => host.rpc.call(method, input))
  const unchanged = async () => {
    expect(catalog).not.toHaveBeenCalled(); expect(executors).toHaveBeenCalled()
    expect(await readFile(host.path, 'utf8')).toBe(bytes)
    expect((await host.rpc.call('space.state', {})).state).toEqual(state)
    expect(host.h.started).toEqual([]); expect(host.h.inner.kernel.stop).not.toHaveBeenCalled()
    expect(calls.mock.calls.every(([method]) => ['space.mote.preferences.read', 'space.mote.dialogue.read', 'space.state'].includes(method))).toBe(true)
    expect(calls.mock.calls.filter(([method]) => method === 'space.mote.preferences.read').every(([, input]) => input.includeChoices === 'executors')).toBe(true)
  }
  return { host, scope, calls, unchanged }
}

it('actual Desktop Main action qualifies its original role and ready Executor while catalog would never return', async () => {
  const x = await original()
  vi.spyOn(api.motePreferences, 'read').mockImplementation(input => x.calls('space.mote.preferences.read', input))
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(input => x.calls('space.mote.dialogue.read', input))
  vi.spyOn(api.spatial, 'read').mockImplementation(async () => (await x.calls('space.state', {})).state)
  let reading: MoteMainActionReading | undefined, failure: unknown
  void readMoteMainAction(x.scope).then(value => { reading = value }, error => { failure = error })
  await observe(() => reading !== undefined || failure !== undefined)
  expect(reading?.executor?.id, 'The original ready Executor must reach the actual Desktop Main action without catalog discovery').toBe('saved')
  expect(failure).toBeUndefined(); expect(reading!.issue).toBeNull(); expect(reading!.operationId).toMatch(/^mote-main:/)
  expect(reading!.preferences.target).toEqual(x.host.target); expect(reading!.dialogue.main.target).toEqual(x.host.target)
  expect(reading!.dialogue.main.status).toBe('ready'); expect(reading!.preferences.choices?.destinations).toBeNull()
  await x.unchanged()
})

it('actual Mobile Main action enables its original create control with a ready Executor while catalog would never return', async () => {
  const x = await original()
  const client = { runtimeOwnerIdentity: () => ({ runtimeId: 'original-private-runtime', ownerInstanceId: 'original-private-owner', availability: 'connected' }),
    forwardRpc: x.calls, onEvent: () => () => {} } as unknown as AgentMuxHostedClient
  const configured = vi.fn(), bound = vi.fn(), view = await mount(<MobileMoteMainActions client={client} target={x.host.target} visible onConfigure={configured} onBound={bound} />)
  const create = () => [...view.element.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '开始对话')
  await observe(() => create() !== undefined)
  expect(create()?.disabled, 'The actual original Mobile Main control must be ready without catalog discovery').toBe(false)
  expect(view.element.textContent).not.toContain('正在核对主对话与配置')
  expect(configured).not.toHaveBeenCalled(); expect(bound).not.toHaveBeenCalled()
  expect(getDeviceWorkface().snapshot().record.agentCreates ?? []).toEqual([])
  await x.unchanged()
})
