import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import {
  parseRendererAllocationsProfile,
  rendererAllocationsJSON,
  type RendererAllocationsProfile
} from '../src/renderer-allocations.js'

const profile = (): RendererAllocationsProfile => ({
  head: {
    id: 0,
    selfSize: 0,
    callFrame: { functionName: 'ROOT_MARKER', scriptId: 'SCRIPT_MARKER', url: '', lineNumber: -1, columnNumber: -1 },
    children: [{
      id: 1,
      selfSize: 32768.25,
      callFrame: {
        functionName: 'FUNCTION_MARKER', scriptId: 'SCRIPT_MARKER',
        url: 'https://allocation.invalid/URL_MARKER', lineNumber: 0, columnNumber: 0
      },
      children: []
    }]
  },
  samples: [{ size: 32768.25, nodeId: 1, ordinal: 0.5 }]
})
function rejection(value: unknown): string {
  let caught: unknown
  try { parseRendererAllocationsProfile(value) } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(AgentMuxError)
  const error = caught as AgentMuxError
  expect(error.code).toBe('CONTROL_PROTOCOL_ERROR')
  expect(error.message.length).toBeLessThanOrEqual(256)
  expect(error.message).not.toMatch(/MARKER|https:|87654321/)
  return error.message
}

it('preserves the original profile, JSON, sentinel positions and fractional sample values', () => {
  const original = profile(), text = JSON.stringify(original)
  expect(parseRendererAllocationsProfile(original)).toBe(original)
  expect(rendererAllocationsJSON(original)).toBe(text)
  expect(JSON.stringify(original)).toBe(text)
})

it.each([
  ['absent reference', (p: RendererAllocationsProfile) => { p.samples[0]!.nodeId = 87654321 }, 'sample.node-reference at samples[0].nodeId'],
  ['duplicate node', (p: RendererAllocationsProfile) => { p.head.children[0]!.id = p.head.id }, 'node.unique-id at head{visit=1}.id'],
  ['duplicate ordinal', (p: RendererAllocationsProfile) => { p.samples.push({ ...p.samples[0]! }) }, 'sample.unique-ordinal at samples[1].ordinal'],
  ['negative position', (p: RendererAllocationsProfile) => { p.head.callFrame.lineNumber = -2 }, 'frame.position-minimum at head{visit=0}.callFrame.lineNumber'],
  ['missing field', (p: RendererAllocationsProfile) => { Reflect.deleteProperty(p.samples[0]!, 'ordinal') }, 'record.required-fields at samples[0]'],
  ['extra private key', (p: RendererAllocationsProfile) => { Object.assign(p.samples[0]!, { PRIVATE_KEY_MARKER: 'VALUE_MARKER' }) }, 'record.json-fields at samples[0]'],
  ['sparse array', (p: RendererAllocationsProfile) => { Reflect.deleteProperty(p.samples, '0') }, 'array.shape at profile.samples'],
  ['foreign array realm', (p: RendererAllocationsProfile) => { p.samples = runInNewContext('[]') as RendererAllocationsProfile['samples'] }, 'array.shape at profile.samples']
] as const)('keeps rejecting %s with a safe first position', (_name, change, expected) => {
  const original = profile()
  change(original)
  expect(rejection(original)).toBe(`Renderer allocation sampling contract is invalid: ${expected}.`)
})

it('does not evaluate or disclose an accessor rejected by the original record guard', () => {
  const original = profile()
  let reads = 0
  Object.defineProperty(original.head.callFrame, 'PRIVATE_KEY_MARKER', {
    enumerable: true,
    get() { reads++; return 'VALUE_MARKER' }
  })
  expect(rejection(original)).toBe('Renderer allocation sampling contract is invalid: record.json-fields at head{visit=0}.callFrame.')
  expect(reads).toBe(0)
})

it('keeps the original reverse sibling visit order when several fields are invalid', () => {
  const original = profile(), first = original.head.children[0]!
  first.callFrame.lineNumber = -2
  original.head.children.push({ ...first, id: -1 })
  expect(rejection(original)).toBe('Renderer allocation sampling contract is invalid: node.id at head{visit=1}.id.')
})

it('reports a bounded structural ordinal without imposing a tree depth limit', () => {
  const original = profile()
  let leaf = original.head.children[0]!
  for (let index = 2; index <= 600; index++) {
    const child = { ...leaf, id: index, children: [] }
    leaf.children.push(child)
    leaf = child
  }
  expect(parseRendererAllocationsProfile(original)).toBe(original)
  leaf.callFrame = { ...leaf.callFrame, columnNumber: -2 }
  expect(rejection(original)).toBe('Renderer allocation sampling contract is invalid: frame.position-minimum at head{visit=600}.callFrame.columnNumber.')
})
