import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import mainSource from '../src/main/ipc.ts?raw'
import preloadSource from '../src/preload/index.ts?raw'
import { SpatialLinkIngress } from '../src/main/spatial-link-ingress'
import { assertSenderTrusted, senderTrust, type PrivilegedChannel } from '../src/main/ipc-sender-trust'
import { focusFacts } from '../../../packages/core/test/fixtures/desktop-focus-facts'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'

/** Execute the registered production callbacks; no copied IPC routing implementation. */
function expression(source: string, select: (node: ts.Node) => ts.Expression | undefined, dependencies: Record<string, unknown>) {
  const ast = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true)
  const found: ts.Expression[] = []
  const visit = (node: ts.Node): void => { const item = select(node); if (item) found.push(item); ts.forEachChild(node, visit) }
  visit(ast)
  expect(found, 'exactly one actual registered source consumer').toHaveLength(1)
  const compiled = ts.transpileModule(`const callback = ${found[0]!.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  return new Function(...Object.keys(dependencies), `${compiled}; return callback`)(...Object.values(dependencies)) as (...args: any[]) => any
}
function mainHandler(dependencies: Record<string, unknown>) {
  return expression(mainSource, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'handleWithEvent' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) &&
    node.arguments[0].text === 'ui:openObjectLink' ? node.arguments[1] : undefined, dependencies)
}
function preloadOpen(invoke: (...args: any[]) => Promise<void>) {
  return expression(preloadSource, node => ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) &&
    node.name.text === 'openObjectLink' ? node.initializer : undefined, { ipcRenderer: { invoke } })
}
const settled = () => new Promise(resolve => setImmediate(resolve))
function fixture(owner: SpatialLinkIngress | undefined = new SpatialLinkIngress()) {
  const trusted = { id: 'original-renderer' }
  const report = vi.fn(), shell = { openExternal: vi.fn() }
  const requireTrustedSender = (channel: PrivilegedChannel, event: { sender: unknown }) => assertSenderTrusted(senderTrust(channel, event.sender, trusted))
  const handler = mainHandler({ args: { spatialLinks: owner }, requireTrustedSender, shell })
  const invoke = vi.fn(async (channel: string, raw: string) => {
    expect(channel).toBe('ui:openObjectLink')
    await handler({ sender: trusted }, raw)
  })
  return { owner: owner!, trusted, handler, invoke, open: preloadOpen(invoke), report, shell }
}
function execution() {
  const requests: AgentMuxControlRequest[] = []
  const execute = vi.fn(async (request: AgentMuxControlRequest): Promise<AgentMuxControlResult> => {
    requests.push(request)
    if (request.operation === 'space.ls') return { operation: 'space.ls', catalog: {
      spaces: [], zones: [], tabs: [], bindings: [],
      regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: 'original SID/中文',
        runId: 'original-run', execution: { hostId: 'local', cwd: _hygiene_fixturePath("original") } }],
      locations: [{ regionId: 'original-region', tabId: 'original-tab', groupId: 'original-group', workspaceId: 'execution-workspace',
        displayWorkspaceId: 'display-workspace', spaceId: null, zoneId: null }]
    } }
    if (request.operation !== 'focus') throw new Error('Unexpected navigation operation')
    const result = focusFacts(request)
    return { ...result, navigation: { ...result.navigation, ...(request.expectedAgentSessionId === undefined ? {} : { expectedAgentSessionId: request.expectedAgentSessionId }) },
      presentation: { provenance: 'observed', state: 'main-visible', tabId: null, regionId: null, blockers: [] } }
  })
  return { requests, execute }
}
describe('inline object links use the original trusted Main navigation owner', () => {
  it('passes the exact Agent URI from preload through Main, waits for readiness and preserves the Session condition and input', async () => {
    const f = fixture(), p = execution()
    await f.open('amux://agent/original%20SID%2F%E4%B8%AD%E6%96%87')
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('ui:openObjectLink', 'amux://agent/original%20SID%2F%E4%B8%AD%E6%96%87')
    expect(p.execute).not.toHaveBeenCalled()
    f.owner.ready(p.execute, f.report); await settled()
    expect(p.requests).toHaveLength(2)
    expect(p.requests[1]).toMatchObject({ operation: 'focus', inputPolicy: 'preserve', expectedAgentSessionId: 'original SID/中文',
      target: { kind: 'space', regionId: 'original-region', tabId: 'original-tab', groupId: 'original-group', displayWorkspaceId: 'display-workspace' } })
    expect(f.report).not.toHaveBeenCalled(); expect(f.shell.openExternal).not.toHaveBeenCalled()
  })
  it('also forwards an exact warm Tab link without treating it as an Agent or using the system browser', async () => {
    const f = fixture(), p = execution(); f.owner.ready(p.execute, f.report)
    await f.open('amux://tab/tab%2Fexact'); await settled()
    expect(p.requests).toHaveLength(1)
    expect(p.requests[0]).toMatchObject({ operation: 'focus', inputPolicy: 'preserve', target: { kind: 'space', tabId: 'tab/exact' } })
    expect(p.requests[0]).not.toHaveProperty('expectedAgentSessionId')
    expect(f.shell.openExternal).not.toHaveBeenCalled()
  })
  it('rejects a lookalike sender before handing any intent to the original owner', () => {
    const f = fixture(), receive = vi.spyOn(f.owner, 'receive')
    expect(() => f.handler({ sender: { ...f.trusted } }, 'amux://agent/original')).toThrow('Untrusted object link navigation sender')
    expect(receive).not.toHaveBeenCalled(); expect(f.shell.openExternal).not.toHaveBeenCalled()
  })
  it('leaves malformed input with the original ingress error owner instead of opening another protocol', async () => {
    const f = fixture(), p = execution(); f.owner.ready(p.execute, f.report)
    await f.open('https://example.invalid'); await settled()
    expect(p.execute).not.toHaveBeenCalled()
    expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('current workface is kept'))
    expect(f.shell.openExternal).not.toHaveBeenCalled()
  })
  it('reports a missing window navigation owner without claiming successful opening', () => {
    const trusted = {}
    const handler = mainHandler({ args: {}, requireTrustedSender: (channel: PrivilegedChannel, event: { sender: unknown }) => assertSenderTrusted(senderTrust(channel, event.sender, trusted)) })
    expect(() => handler({ sender: trusted }, 'amux://agent/original')).toThrow('Object link navigation is unavailable in this window')
  })
  it('does not pretend that the web preview has Main object navigation', async () => {
    const { api } = await import('../src/renderer/src/lib/api')
    await expect(api.ui.openObjectLink('amux://agent/original')).rejects.toThrow('Object link navigation requires the desktop app')
  })
})
