import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AgentMuxControlServer, requestAgentMuxControl } from '../src/control-host.js'
import type { AgentMuxControlFocusRequest, AgentMuxControlRequest, AgentMuxDesktopFocusResult } from '../src/control.js'
import { focusFacts } from './fixtures/desktop-focus-facts.js'

const target = { kind: 'space', spaceId: 'space-b', zoneId: 'zone-a', displayWorkspaceId: 'display-b',
  groupId: 'exact-foreign-group', tabId: 'shared-tab', regionId: 'shared-region' } as const
let root: string, path: string, server: AgentMuxControlServer
let seen: AgentMuxControlRequest[], reply: (request: AgentMuxControlFocusRequest) => AgentMuxDesktopFocusResult

function displayFacts(request: AgentMuxControlFocusRequest): AgentMuxDesktopFocusResult {
  const result = focusFacts(request)
  result.navigation.selection.space = { ...result.navigation.selection.space!,
    workspaceId: target.displayWorkspaceId, groupId: target.groupId }
  return result
}

beforeEach(async () => {
  root = await mkdtemp('/tmp/amux-focus-display-'); path = join(root, 'control.sock'); seen = []; reply = displayFacts
  server = new AgentMuxControlServer({ async execute(request) {
    seen.push(request)
    if (request.operation !== 'focus') throw new Error('Only the public Focus transport is allowed in this fixture')
    return reply(request)
  } }, path)
  await server.start()
})
afterEach(async () => {
  await server.stop(); await rm(root, { recursive: true })
  if (process.env.AGENTMUX_FOCUS_DISPLAY_CLEANUP) await appendFile(process.env.AGENTMUX_FOCUS_DISPLAY_CLEANUP,
    JSON.stringify({ root, socket: path, stopped: true, removed: true }) + '\n')
})

function request(): AgentMuxControlFocusRequest {
  return { schemaVersion: 5, requestId: 'focus-display', operation: 'focus', target, inputPolicy: 'preserve' }
}

it.each(['applied', 'unchanged'] as const)('accepts %s navigation at the exact foreign display address over the public Unix transport', async state => {
  reply = request => { const result = displayFacts(request); result.navigation.state = state; return result }
  const outcome = await requestAgentMuxControl(request(), path)
    .then(receipt => ({ receipt, error: null }), error => ({ receipt: null, error }))
  expect(outcome.error).toBeNull()
  expect(outcome.receipt).not.toBeNull()
  const receipt = outcome.receipt
  if (!receipt) throw new Error('Expected the actual public Focus receipt')
  expect(seen).toEqual([request()])
  expect(receipt.operation).toBe('focus')
  if (receipt.operation !== 'focus') throw new Error('Expected the public Focus receipt')
  expect(receipt.result.navigation).toEqual({ state, requested: target, selection: {
    surface: 'space', mainSurface: 'workbench', goalId: 'previous-goal', space: {
      spaceId: target.spaceId, zoneId: target.zoneId, workspaceId: target.displayWorkspaceId,
      groupId: target.groupId, tabId: target.tabId, regionId: target.regionId, topicId: null } } })
  // The resource home is deliberately different; it must never replace the explicit display location.
  expect(receipt.result.navigation.selection.space!.workspaceId).not.toBe('resource-home-a')
  expect(receipt.result.partial).toBe(true) // This typed client does not invent DOM/Native visibility.
})

it.each(['workspaceId', 'spaceId', 'zoneId', 'groupId', 'tabId', 'regionId'] as const)('rejects a different receipt %s without weakening the other parent constraints', async key => {
  reply = request => {
    const result = displayFacts(request)
    result.navigation.selection.space = { ...result.navigation.selection.space!, [key]: key === 'workspaceId' ? 'resource-home-a' : `wrong-${key}` }
    return result
  }
  await expect(requestAgentMuxControl(request(), path)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(seen).toEqual([request()])
})

it('rejects a missing display selection rather than guessing the resource home', async () => {
  reply = request => { const result = displayFacts(request); result.navigation.selection.space = null; return result }
  await expect(requestAgentMuxControl(request(), path)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(seen).toEqual([request()])
})

it('rejects a receipt-only displayWorkspaceId field instead of adding another protocol field', async () => {
  reply = request => {
    const result = displayFacts(request)
    Object.assign(result.navigation.selection.space!, { displayWorkspaceId: target.displayWorkspaceId })
    return result
  }
  await expect(requestAgentMuxControl(request(), path)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(seen).toEqual([request()])
})

it('keeps requests without an explicit display constraint strict only about their recorded parents', async () => {
  const minimal = { ...request(), target: { kind: 'space' as const, tabId: target.tabId, regionId: target.regionId } }
  const receipt = await requestAgentMuxControl(minimal, path)
  expect(seen).toEqual([minimal])
  expect(receipt.operation).toBe('focus')
  if (receipt.operation !== 'focus') throw new Error('Expected Focus')
  expect(receipt.result.navigation.selection.space).toMatchObject({ workspaceId: target.displayWorkspaceId, tabId: target.tabId, regionId: target.regionId })
})
