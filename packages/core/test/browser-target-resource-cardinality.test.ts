import { describe, expect, it } from 'vitest'
import type { AgentMuxBrowserTarget } from '../src/browser-targets.js'
import { parseAgentMuxControlReceipt } from '../src/control-codec.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../src/control.js'

const location = (index: number) => ({ workspaceId: 'workspace', tabId: 'tab', regionId: `region-${index}` })
const processIdentity = (index: number) => ({ pid: index + 1, creationTime: index + 1 })
function target(index = 0): AgentMuxBrowserTarget {
  return { id: `browser-${index}`, workspaceId: 'workspace', source: 'embedded', status: 'ready',
    url: 'https://example.invalid/', title: 'Original Browser', navigationId: `navigation-${index}`, capabilities: [],
    resource: { state: 'live', locations: [location(index)], processes: [processIdentity(index)] } }
}
function wire(targets: readonly AgentMuxBrowserTarget[]) {
  return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'resource-discovery', ok: true,
    operation: 'browser.targets', result: { targets, coverage: 'complete' } }
}
function expectDecoded(input: ReturnType<typeof wire>) {
  let actual: unknown
  expect(() => { actual = parseAgentMuxControlReceipt(input) }).not.toThrow()
  expect(actual).toEqual(input)
}

describe('Browser resource discovery through the public receipt codec', () => {
  it('retains every distinct saved Browser beyond a cumulative page count', () => {
    const input = wire(Array.from({ length: 257 }, (_, index) => target(index)))
    expectDecoded(input)
  })

  it('retains every durable location of the same Browser', () => {
    const browser = target()
    browser.resource = { ...browser.resource!, locations: Array.from({ length: 257 }, (_, index) => location(index)) }
    const input = wire([browser])
    expectDecoded(input)
  })

  it('retains each distinct process identity without inventing a per-page process budget', () => {
    const browser = target()
    browser.resource = { ...browser.resource!, processes: Array.from({ length: 257 }, (_, index) => processIdentity(index)) }
    const input = wire([browser])
    expectDecoded(input)
  })

  it('still rejects duplicate and invalid ownership facts', () => {
    expect(() => parseAgentMuxControlReceipt(wire([target(), target()]))).toThrow('identity')
    const browser = target()
    browser.resource = { state: 'live', locations: [location(0), location(0)], processes: [] }
    expect(() => parseAgentMuxControlReceipt(wire([browser]))).toThrow('positions')
    browser.resource = { state: 'live', locations: [], processes: [processIdentity(0), processIdentity(0)] }
    expect(() => parseAgentMuxControlReceipt(wire([browser]))).toThrow('duplicated')
    browser.resource = { state: 'cold', locations: [], processes: [processIdentity(0)] }
    expect(() => parseAgentMuxControlReceipt(wire([browser]))).toThrow('Unloaded')
  })
})
