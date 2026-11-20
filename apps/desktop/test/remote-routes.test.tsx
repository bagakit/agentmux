// @vitest-environment happy-dom
import { chooseField } from './helpers/selection-field'
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import * as core from '../../../packages/core/src/index'
import { AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION } from '../../../packages/core/src/runtime-owner-protocol'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { callDesktopHostRoute } from '../src/main/host-routes-client'
import type { AppConfig } from '../src/shared/contracts'
import type { DesktopHostRoutes } from '../src/shared/host-routes'
import { api } from '../src/renderer/src/lib/api'
import * as store from '../src/renderer/src/store'
import { hostRouteDraft, putHostRouteDraft, readHostRouteDraft } from '../src/renderer/src/lib/host-route-draft'
import { parseHostRouteGrantRequest, grantForRouteReceiver } from '../src/renderer/src/lib/host-route-grant-request'
import { RemoteRoutesPane } from '../src/renderer/src/components/settings/RemoteRoutesPane'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
beforeEach(() => { store.useAppStore.setState({ hostRouteDrafts: {} }); vi.spyOn(store, 'checkpointHostRouteDrafts').mockResolvedValue() })

async function fixture() {
  const parent = await rpcOwnerFixture([], core); cleanups.push(parent.close)
  const nodes = new Map<string, { rpc: core.AgentMuxRpcClient; identity: core.HostRouteIdentity; client: { forwardRpc: core.AgentMuxRpcClient['call'] } }>()
  const calls: Array<{ node: string; method: string; params: unknown }> = [], probes: string[] = []
  let afterCall: ((node: string, method: string, value: unknown) => Promise<unknown>) | undefined
  for (const name of ['D', 'C', 'B']) {
    const authority = new core.AgentMuxCreationAuthority({ stateDirectory: join(parent.root, name), runtimeId: name + '-runtime' }), identity = await authority.identity()
    const owner: core.AgentMuxRuntimeOwnerIdentity = { runtimeId: identity.runtimeId, ownerInstanceId: name + '-instance', protocolVersion: AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION, processId: process.pid, availability: 'connected', ctxmux: null }
    const hosted = new core.AgentMuxHostedRuntimeService(parent.client, null, () => owner)
    let server: core.AgentMuxControlServer
    const gateway = new core.HostRouteGateway({ authority, stateDirectory: join(parent.root, name), edges: async () => name === 'D' ? [] : [{ edgeId: name === 'B' ? 'C' : 'D', label: name === 'B' ? 'Compute' : 'Build node', kind: 'ssh' as const, runtimeId: nodes.get(name === 'B' ? 'C' : 'D')!.identity.runtimeId }],
      edge: id => { probes.push(name + '/' + id); return core.hostRouteTransport(nodes.get(id)!.rpc) },
      call: (method, params, context) => server.callRpc(method, params, context), subscribe: (method, params, emit, context) => server.subscribeRpc(method, params, emit, context) })
    server = new core.AgentMuxControlServer({ hostRoutes: gateway, hostedRuntime: () => hosted }, join(parent.root, name + '.sock')); await server.start()
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    cleanups.push(async () => { await rpc.dispose(); gateway.dispose(); await hosted.dispose(); await server.stop() })
    const client = { forwardRpc: async (...args: Parameters<core.AgentMuxRpcClient['call']>) => {
      calls.push({ node: name, method: args[0], params: args[1] }); const value = await rpc.call(...args)
      return afterCall ? await afterCall(name, args[0], value) : value
    } } as { forwardRpc: core.AgentMuxRpcClient['call'] }
    nodes.set(name, { rpc, identity, client })
  }
  const bridge: DesktopHostRoutes = { call: (target, method, input, signal) => callDesktopHostRoute(id => nodes.get(id === 'local' ? 'B' : id)!.client as never, target, method, input, signal) }
  Object.assign(api, { hostRoutes: bridge })
  const config: AppConfig = { ...composerConfig, hosts: [{ id: 'local', kind: 'local', label: 'Project node' }, { id: 'C', kind: 'ssh', label: 'Compute', hostname: 'unused.invalid' }] }
  return { nodes, calls, probes, config, intercept: (value: typeof afterCall) => { afterCall = value } }
}
async function flush(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }) }
async function button(text: string) {
  const matches = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].filter(node => node.textContent?.trim() === text)
  expect(matches, `Button: ${text}`).toHaveLength(1); await act(async () => matches[0]!.click())
}
async function field(label: string, value: string) {
  const element = dom.container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!
  expect(element).not.toBeNull()
  if (element.classList.contains('selection-field')) { await chooseField(element, value); return }
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) })
}
async function newRoute(f: Awaited<ReturnType<typeof fixture>>) {
  await dom.render(<RemoteRoutesPane config={f.config} active />)
  await flush(() => expect(dom.container.querySelector('[aria-label="Next saved route connection"]')).not.toBeNull())
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Next saved route connection"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await flush(() => expect(document.querySelectorAll('.selection-field__menu [role="option"]')).toHaveLength(2))
  expect(f.probes).toEqual([])
  await field('Next saved route connection', 'C'); await button('Inspect & add')
  await flush(() => expect(dom.container.querySelector('[aria-label="Route name"]')).not.toBeNull())
  await field('Route name', 'compute')
}
test('route device choices expose a stable identity alongside duplicate display names', async () => {
  const f = await fixture()
  await dom.render(<RemoteRoutesPane config={f.config} active />)
  await flush(() => expect(dom.container.querySelector('[aria-label="Next saved route connection"]')).not.toBeNull())
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Route policy device"]')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await flush(() => expect(document.querySelector('.selection-field__menu [data-value="C"]')).not.toBeNull())
  expect(document.querySelector('.selection-field__menu')?.classList.contains('host-route-owner__menu')).toBe(true)
  expect(document.querySelector('.selection-field__menu [data-value="C"]')?.textContent).toContain('Compute · C')
  await act(async () => document.querySelector<HTMLElement>('.selection-field__menu [data-value="C"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await flush(() => expect(trigger.dataset.value).toBe('C'))
  expect(trigger.textContent).toContain('Compute · C')
})
test('saved route edge choices expose a stable edge ID beside the connection label', async () => {
  const f = await fixture()
  await dom.render(<RemoteRoutesPane config={f.config} active />)
  await flush(() => expect(dom.container.querySelector('[aria-label="Next saved route connection"]')).not.toBeNull())
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Next saved route connection"]')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await flush(() => expect(document.querySelector('.selection-field__menu [data-value="C"]')).not.toBeNull())
  expect(document.querySelector('.selection-field__menu [data-value="C"]')?.textContent).toContain('Compute · C')
})
test('the Desktop route editor keeps the inspected Relay carrier in the saved path', async () => {
  const f = await fixture()
  f.intercept(async (_node, method, value) => {
    if (method === 'route.edges') {
      const list = value as core.HostRouteEdges
      return { ...list, edges: list.edges.map(edge => ({ ...edge, kind: 'relay' })) }
    }
    if (method === 'route.edge.inspect') {
      const reply = value as { edge: { kind: string } }
      return { ...reply, edge: { ...reply.edge, kind: 'relay' } }
    }
    return value
  })
  await newRoute(f)
  await button('Save policy'); await flush(() => expect(dom.container.textContent).toContain('Route policy saved'))
  const saved = await f.nodes.get('B')!.rpc.call('route.inspect', {})
  expect(saved.routes[0]?.route.hops).toEqual([{ edgeId: 'C', target: f.nodes.get('C')!.identity, kind: 'relay' }])
})
test('does not inspect a stale edge after the route path changes', async () => {
  const f = await fixture(); await newRoute(f)
  await button('Save policy'); await flush(() => expect(dom.container.textContent).toContain('Route policy saved'))
  await button('New route'); await field('Next saved route connection', 'C')
  const inspections = f.calls.filter(call => call.method === 'route.edge.inspect').length
  await dom.click('[data-resource-row="0"]')
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Next saved route connection"]')!
  await flush(() => expect(trigger.dataset.value).toBe(''))
  const add = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Inspect & add')!
  expect(add.disabled).toBe(true)
  await button('Inspect & add')
  expect(f.calls.filter(call => call.method === 'route.edge.inspect')).toHaveLength(inspections)
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Route name"]')!.value).toBe('compute')
})
test('actual Remote route editor browses saved edges without probes or writes and explicitly saves to its original Core', async () => {
  const f = await fixture(); await newRoute(f)
  expect(f.probes).toEqual(['B/C']); expect(f.calls.filter(call => call.method === 'route.configure')).toEqual([])
  expect(dom.container.querySelector('.host-route-path')?.textContent).toContain('Project node')
  await button('Save policy')
  await flush(() => expect(dom.container.textContent).toContain('Route policy saved'))
  expect(f.calls.filter(call => call.method === 'route.configure')).toHaveLength(1)
  const saved = await f.nodes.get('B')!.rpc.call('route.inspect', {})
  expect(saved.routes[0]).toEqual({ id: 'compute', route: { source: f.nodes.get('B')!.identity, hops: [{ edgeId: 'C', target: f.nodes.get('C')!.identity }] } })
  expect((await f.nodes.get('C')!.rpc.call('route.inspect', {})).routes).toEqual([])
  await flush(() => expect(dom.container.textContent).toContain('Route policy saved'))
})
test('unsaved prefix exploration performs no hidden save and exact receiver denial retains the route and its draft', async () => {
  const f = await fixture(); await newRoute(f)
  await button('Explore next node')
  expect(dom.container.textContent).toContain('Save this route explicitly')
  expect(dom.container.querySelector<HTMLButtonElement>('.settings-pane-actions button')!.disabled).toBe(false)
  expect(f.calls.filter(call => call.method === 'route.configure')).toEqual([])
  await button('Save policy'); await flush(() => expect(dom.container.textContent).toContain('Route policy saved'))
  await button('Explore next node')
  await flush(() => expect(dom.container.textContent).toContain('has not delegated'))
  expect((dom.container.querySelector('[aria-label="Route name"]') as HTMLInputElement).value).toBe('compute')
  expect(f.calls.filter(call => call.method === 'route.configure')).toHaveLength(1)
})
test('a lost save ACK remains an original request, readback never resends it and a later explicit save retains both edits', async () => {
  const f = await fixture(); await newRoute(f)
  f.intercept(async (_node, method, value) => { if (method === 'route.configure') throw Error('Original ACK unavailable'); return value })
  await button('Save policy'); await flush(() => expect(dom.container.textContent).toContain('save result is unconfirmed'))
  const first = f.calls.find(call => call.method === 'route.configure')!.params as core.HostRouteParams['route.configure']
  expect(readHostRouteDraft(store.useAppStore.getState().hostRouteDrafts, 'B-runtime')!.retainedSaves[0]!.input).toEqual(first)
  await button('Read saved policy'); await flush(() => expect(dom.container.textContent).toContain('Observed at this owner; original acknowledgment unavailable'))
  expect(f.calls.filter(call => call.method === 'route.configure')).toHaveLength(1)
  await field('Route name', 'updated-compute'); await button('Keep edits over saved policy')
  f.intercept(undefined); await button('Save policy'); await flush(() => expect(dom.container.textContent).toContain('Route policy saved'))
  const edit = readHostRouteDraft(store.useAppStore.getState().hostRouteDrafts, 'B-runtime')!
  expect(edit.configuration.routes[0]!.id).toBe('updated-compute'); expect(edit.retainedSaves.map(row => row.input.operationId)).toEqual([first.operationId])
  expect(f.calls.filter(call => call.method === 'route.configure')).toHaveLength(2)
})
test('a late original ACK preserves a newer route name and hidden pane state while the user document retains its authored input', async () => {
  const f = await fixture(); await newRoute(f)
  let release!: () => void, waiting = false
  const paused = new Promise<void>(done => { release = done })
  f.intercept(async (_node, method, value) => { if (method === 'route.configure') { waiting = true; await paused } return value })
  await button('Save policy'); await flush(() => expect(waiting).toBe(true))
  await field('Route name', 'edited-while-saving')
  await dom.render(<RemoteRoutesPane config={f.config} active={false} />); release()
  await flush(() => expect(readHostRouteDraft(store.useAppStore.getState().hostRouteDrafts, 'B-runtime')!.baseline.routes[0]!.id).toBe('compute'))
  await dom.render(<RemoteRoutesPane config={f.config} active />)
  await flush(() => expect(dom.container.textContent).toContain('Route policy: unsaved changes'))
  expect((dom.container.querySelector('[aria-label="Route name"]') as HTMLInputElement).value).toBe('edited-while-saving')
  const state = store.useAppStore.getState(), persisted = store.useAppStore.persist.getOptions().partialize!(state) as { hostRouteDrafts: unknown }
  expect(persisted.hostRouteDrafts).toBeDefined()
  const restored = readHostRouteDraft(JSON.parse(JSON.stringify(persisted.hostRouteDrafts)), 'B-runtime')
  expect(restored).toBeDefined(); expect(restored?.configuration.routes[0]?.id).toBe('edited-while-saving')
})
test('a failed private checkpoint sends no policy write and retains the original unsent operation without disabling other work', async () => {
  const f = await fixture(); await newRoute(f)
  vi.mocked(store.checkpointHostRouteDrafts).mockRejectedValue(Error('Native user document ACK unavailable'))
  await button('Save policy'); await flush(() => expect(dom.container.textContent).toContain('save was not sent'))
  expect(f.calls.filter(call => call.method === 'route.configure')).toEqual([])
  const edit = readHostRouteDraft(store.useAppStore.getState().hostRouteDrafts, 'B-runtime')!
  expect(edit.retainedSaves[0]!.notSent).toBe(true); expect(edit.configuration.routes[0]!.id).toBe('compute')
  expect(store.useAppStore.getState().sessions).toHaveLength(1)
})
test('an older window save ACK cannot roll back a later explicitly confirmed policy revision', async () => {
  const f = await fixture(); await newRoute(f)
  let release!: () => void, held = false
  const pending = new Promise<void>(done => { release = done })
  f.intercept(async (_node, method, value) => { if (method === 'route.configure' && !held) { held = true; await pending } return value })
  await button('Save policy'); await flush(() => expect(held).toBe(true))
  await dom.render(<></>); await dom.render(<RemoteRoutesPane config={f.config} active />)
  await flush(() => expect(dom.container.textContent).toContain('Keep edits over saved policy'))
  await dom.click('[data-resource-row="0"]'); await field('Route name', 'newer-window-edit'); await button('Keep edits over saved policy')
  await button('Save policy'); await flush(() => expect(dom.container.textContent).toContain('Route policy saved'))
  const newer = (await f.nodes.get('B')!.rpc.call('route.inspect', {})).revision
  release(); await flush(() => expect(readHostRouteDraft(store.useAppStore.getState().hostRouteDrafts, 'B-runtime')!.retainedSaves).toEqual([]))
  const retained = readHostRouteDraft(store.useAppStore.getState().hostRouteDrafts, 'B-runtime')!
  expect(retained.baseline.revision).toBe(newer); expect(retained.configuration.routes[0]?.id).toBe('newer-window-edit')
})
test('a local checkpoint failure after the original Core ACK retains the confirmed policy without reporting business failure', async () => {
  const f = await fixture(); await newRoute(f)
  vi.mocked(store.checkpointHostRouteDrafts).mockResolvedValueOnce().mockRejectedValueOnce(Error('Local checkpoint ACK unavailable'))
  await button('Save policy'); await flush(() => expect(dom.container.textContent).toContain('Policy saved at the original Core. The local edit checkpoint is unconfirmed.'))
  const edit = readHostRouteDraft(store.useAppStore.getState().hostRouteDrafts, 'B-runtime')!
  expect(edit.retainedSaves).toEqual([])
  expect(edit.baseline.operation?.operationId).toBe((await f.nodes.get('B')!.rpc.call('route.inspect', {})).operation?.operationId)
  expect(edit.configuration.routes[0]?.id).toBe('compute'); expect(f.calls.filter(call => call.method === 'route.configure')).toHaveLength(1)
})
test('an exact Core CAS refusal retains the original request as refused rather than unknown or unsent', async () => {
  const f = await fixture(); await newRoute(f)
  const node = f.nodes.get('B')!, before = await node.rpc.call('route.inspect', {})
  await node.rpc.call('route.configure', { expectedRevision: before.revision, operationId: 'independent-policy-save', configuration: { routes: [], grants: [] } })
  await button('Save policy'); await flush(() => expect(dom.container.textContent).toContain('The original Core refused this save. Your edit is retained.'))
  const edit = readHostRouteDraft(store.useAppStore.getState().hostRouteDrafts, 'B-runtime')!
  expect(edit.retainedSaves[0]?.refusal?.code).toBe('HOST_ROUTE_POLICY_CHANGED'); expect(edit.retainedSaves[0]?.notSent).toBeUndefined()
  expect(edit.configuration.routes[0]?.id).toBe('compute'); expect((await node.rpc.call('route.inspect', {})).operation?.operationId).toBe('independent-policy-save')
  expect(dom.container.textContent).not.toContain('save result is unconfirmed')
})
test('a late exact edge inspection merges into current route and grant edits without overwriting either', async () => {
  const f = await fixture(); await newRoute(f); await button('Save policy'); await flush(() => expect(dom.container.textContent).toContain('Route policy saved'))
  const b = f.nodes.get('B')!, c = f.nodes.get('C')!, d = f.nodes.get('D')!
  const saved = await c.rpc.call('route.inspect', {})
  await c.rpc.call('route.configure', { expectedRevision: saved.revision, operationId: 'receiver-read-grant', configuration: { routes: [], grants: [{ id: 'explicit-read', delegator: b.identity,
    actor: { source: b.identity, kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` }, destination: c.identity, scopes: ['route.edges', 'route.edge.inspect'] }] } })
  await button('Explore next node')
  await flush(() => expect(dom.container.querySelector('[aria-label="Next saved route connection"]')).not.toBeNull())
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Next saved route connection"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await flush(() => expect(document.querySelector('.selection-field__menu [data-value="D"]')).not.toBeNull())
  await field('Next saved route connection', 'D')
  let release!: () => void, waiting = false
  const pending = new Promise<void>(done => { release = done })
  f.intercept(async (_node, method, value) => { if (method === 'route.call') { waiting = true; await pending } return value })
  await button('Inspect & add'); await flush(() => expect(waiting).toBe(true))
  await field('Route name', 'renamed-while-inspecting'); await button('Incoming access 0')
  const request = { kind: 'host-route-access', route: { source: d.identity, hops: [{ edgeId: 'B', target: b.identity }] }, actor: { source: d.identity, kind: 'user', id: 'other-original-user' }, scopes: ['route.edges'] }
  await field('Public route access request', JSON.stringify(request)); await button('Add to this node’s edit')
  release(); await flush(() => expect(readHostRouteDraft(store.useAppStore.getState().hostRouteDrafts, 'B-runtime')!.configuration.routes[0]?.route.hops).toHaveLength(2))
  const edit = readHostRouteDraft(store.useAppStore.getState().hostRouteDrafts, 'B-runtime')!
  expect(edit.configuration.routes[0]?.id).toBe('renamed-while-inspecting'); expect(edit.configuration.grants).toHaveLength(1)
  expect(edit.configuration.grants[0]?.actor).toEqual(request.actor); expect(f.calls.filter(call => call.method === 'route.configure')).toHaveLength(1)
})
test('public grant requests map to the exact receiving node and add only an explicit private edit before Save', async () => {
  const f = await fixture(), b = f.nodes.get('B')!, c = f.nodes.get('C')!, actor = { source: b.identity, kind: 'user' as const, id: 'original-source-person' }
  const route = { source: b.identity, hops: [{ edgeId: 'C', target: c.identity }] }
  const request = parseHostRouteGrantRequest({ kind: 'host-route-access', route, actor, scopes: ['route.edges'] })
  expect(grantForRouteReceiver(request, c.identity, 'finite-read')).toEqual({ id: 'finite-read', delegator: b.identity, actor, destination: c.identity, scopes: ['route.edges'] })
  expect(() => grantForRouteReceiver(request, b.identity, 'wrong-owner')).toThrow('does not pass through')
  await dom.render(<RemoteRoutesPane config={f.config} active />)
  await field('Route policy device', 'C'); await flush(() => expect(dom.container.querySelector('.remote-work-tasks')?.textContent).toContain('Incoming access 0'))
  await button('Incoming access 0'); await field('Public route access request', JSON.stringify(request)); await button('Add to this node’s edit')
  expect(f.calls.filter(call => call.method === 'route.configure')).toEqual([])
  await button('Save policy'); await flush(() => expect(dom.container.textContent).toContain('Route policy saved'))
  expect(f.calls.filter(call => call.method === 'route.configure')).toHaveLength(1)
  expect((await c.rpc.call('route.inspect', {})).grants[0]).toMatchObject({ delegator: b.identity, actor, destination: c.identity, scopes: ['route.edges'] })
})
test('unrelated opaque edits and invalid names survive serialization without becoming an accepted policy', async () => {
  const f = await fixture(), saved = await f.nodes.get('B')!.rpc.call('route.inspect', {}), draft = hostRouteDraft(structuredClone(saved))
  const opaque = { future: { preserve: ['original'] } }
  const value = putHostRouteDraft(opaque, 'B-runtime', draft) as Record<string, unknown>
  expect(value.future).toEqual(opaque.future)
  draft.configuration.routes.push({ id: '', route: { source: saved.identity, hops: [{ edgeId: 'C', target: f.nodes.get('C')!.identity }] } })
  expect(readHostRouteDraft(JSON.parse(JSON.stringify(value)), 'B-runtime')!.configuration.routes[0]!.id).toBe('')
  expect(() => core.parseHostRouteConfiguration(draft.configuration)).toThrow()
})
