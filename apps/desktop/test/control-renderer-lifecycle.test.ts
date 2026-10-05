import { fixtureFileUrl as _hygiene_fixtureFileUrl } from "../scripts/lib/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxControlTimeoutMs } from '@agentmux/core/control'
import type { AgentMuxControlRequest } from '@agentmux/core'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
import * as productionIpc from '../src/main/ipc'

// The owning config exposes precisely this Main entry as source after the mutation
// helper records its original bytes. No application-wide Electron bootstrap executes.
const sourceText = (productionIpc as unknown as { sourceText: string }).sourceText
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers() })

function fixture(eagerEvent = false) {
  const source = ts.createSourceFile('ipc.ts', sourceText, ts.ScriptTarget.Latest, true)
  const required = new Set(['releaseHtmlPreviews', 'releaseRendererResources', 'releaseNavigatedHtmlPreviews', 'acceptingControl', 'controlBridge'])
  const declarations = new Map<string, ts.VariableStatement>()
  const registrations: ts.ExpressionStatement[] = [], removals: ts.ExpressionStatement[] = []
  function visit(node: ts.Node) {
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && required.has(declaration.name.text)) {
        expect(declarations.has(declaration.name.text), 'each actual owner declaration occurs once').toBe(false)
        declarations.set(declaration.name.text, node)
      }
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression, event = call.arguments[0]
      if (event && ts.isStringLiteral(event) && ['render-process-gone', 'did-start-navigation'].includes(event.text) && ts.isPropertyAccessExpression(call.expression)) {
        if (call.expression.expression.getText(source) === 'args.window.webContents') {
          if (call.expression.name.text === 'on') registrations.push(node)
          if (call.expression.name.text === 'off') removals.push(node)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect([...declarations.keys()].sort()).toEqual([...required].sort())
  expect(registrations).toHaveLength(2)
  expect(removals).toHaveLength(2)
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const sent: { channel: string; request: unknown }[] = []
  const resources = { htmlPreviews: { releaseAll: vi.fn() }, previewResources: { cancelAll: vi.fn() },
    diagramPreviews: { cancelAll: vi.fn() }, builds: { releaseAll: vi.fn(async () => {}) } }
  const webContents = { isDestroyed: () => false,
    send(channel: string, request: unknown) { sent.push({ channel, request }) },
    on(event: string, handler: (...args: unknown[]) => void) {
      expect(handlers.has(event)).toBe(false); handlers.set(event, handler)
      if (eagerEvent && event === 'render-process-gone') handler()
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      expect(handlers.get(event)).toBe(handler); handlers.delete(event)
    } }
  const dependencies = { ...resources, DesktopControlIpcBridge, args: { window: { isDestroyed: () => false, webContents } },
    CONTROL_REQUEST_CHANNEL: 'control-request', CONTROL_CANCEL_CHANNEL: 'control-cancel' }
  // Preserve real source order. An event registered before controlBridge construction
  // can fire during an await in registerIpc; eagerEvent makes that TDZ observable.
  const selected = [...declarations.values(), ...registrations].sort((a, b) => a.pos - b.pos)
  const code = `${selected.map(node => node.getText(source)).join('\n')}\nreturn { bridge: controlBridge, disposeListeners: () => { ${removals.map(node => node.getText(source)).join('\n')} } };`
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const owners = new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies)) as {
    bridge: DesktopControlIpcBridge; disposeListeners(): void
  }
  cleanups.push(() => { owners.bridge.dispose(); owners.disposeListeners() })
  return { ...owners, handlers, sent, resources }
}
function request(): Extract<AgentMuxControlRequest, { operation: 'file.format' }> {
  return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'original-operation', operation: 'file.format', regionId: 'original-region' }
}
function result() { return { operation: 'file.format' as const, regionId: 'original-region', status: 'unchanged' as const, message: null } }

describe('production Main Renderer owner lifecycle callbacks', () => {
  it.each([
    { event: 'render-process-gone', args: [], retired: true, previews: true },
    { event: 'did-start-navigation', args: [{}, _hygiene_fixtureFileUrl("replacement.html"), false, true], retired: true, previews: true },
    { event: 'did-start-navigation', args: [{}, _hygiene_fixtureFileUrl("current.html#section"), true, true], retired: false, previews: true },
    { event: 'did-start-navigation', args: [{}, _hygiene_fixtureFileUrl("child.html"), false, false], retired: false, previews: false }
  ])('$event $args retires=$retired while preserving existing preview release', async scenario => {
    vi.useFakeTimers()
    const f = fixture()
    const observation = f.bridge.execute(request()).catch(error => error)
    await vi.advanceTimersByTimeAsync(agentMuxControlTimeoutMs('file.format'))
    expect(await observation).toMatchObject({ code: 'CONTROL_TIMEOUT' })
    f.handlers.get(scenario.event)!(...scenario.args)
    for (const resource of Object.values(f.resources)) {
      expect(('releaseAll' in resource ? resource.releaseAll : resource.cancelAll).mock.calls).toHaveLength(scenario.previews ? 1 : 0)
    }
    expect(f.sent.filter(item => item.channel === 'control-cancel')).toHaveLength(scenario.retired ? 1 : 0)
    if (scenario.retired) {
      expect(f.bridge.accept({ requestId: request().requestId, ok: true, result: result() })).toBe(false)
      const replacement = f.bridge.execute(request())
      expect(f.sent.filter(item => item.channel === 'control-request')).toHaveLength(2)
      expect(f.bridge.accept({ requestId: request().requestId, ok: true, result: result() })).toBe(true)
      expect(await replacement).toEqual(result())
    } else {
      await expect(f.bridge.execute(request())).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
      expect(f.sent.filter(item => item.channel === 'control-request')).toHaveLength(1)
      expect(f.bridge.accept({ requestId: request().requestId, ok: true, result: result() })).toBe(true)
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('constructs the bridge before an invalidation event can run, and unregisters exact callbacks', () => {
    const f = fixture(true)
    expect(f.resources.htmlPreviews.releaseAll).toHaveBeenCalledOnce()
    f.disposeListeners()
    expect(f.handlers.size).toBe(0)
    cleanups.pop()
    f.bridge.dispose()
  })
})
