import { describe, expect, it } from 'vitest'
import { MAX_TOOL_OUTPUT_CHARS, formatHookToolOutput } from '../src/hook-tool-outcome.js'

describe('formatting a Provider-selected original result', () => {
  it('formats text and scalar values without interpreting them as failure', () => {
    expect(formatHookToolOutput('  total 24\ndrwxr-xr-x  ')).toBe('total 24\ndrwxr-xr-x')
    expect(formatHookToolOutput('failed error exit 1')).toBe('failed error exit 1')
    expect(formatHookToolOutput(0)).toBe('0')
    expect(formatHookToolOutput(false)).toBe('false')
  })

  it('preserves the selected JSON instead of searching protocol or nested text keys', () => {
    const value = { stdout: 'body', stderr: 'warning', error: 'data', status: 'error', code: 1 }
    expect(formatHookToolOutput(value)).toBe(JSON.stringify(value))
    expect(formatHookToolOutput({ tool_response: 'body', toolResult: { textResultForLlm: 'other' } }))
      .toBe('{"tool_response":"body","toolResult":{"textResultForLlm":"other"}}')
    expect(formatHookToolOutput({ is_error: true })).toBe('{"is_error":true}')
  })

  it('retains the existing blank/missing formatting without deciding failure', () => {
    expect(formatHookToolOutput(undefined)).toBeUndefined()
    expect(formatHookToolOutput('')).toBeUndefined()
    expect(formatHookToolOutput('   ')).toBeUndefined()
    expect(formatHookToolOutput({})).toBe('{}')
  })

  it('bounds a selected result and explicitly marks truncation', () => {
    expect(MAX_TOOL_OUTPUT_CHARS).toBe(4000)
    expect(formatHookToolOutput('x'.repeat(MAX_TOOL_OUTPUT_CHARS))).toBe('x'.repeat(MAX_TOOL_OUTPUT_CHARS))
    const output = formatHookToolOutput('x'.repeat(MAX_TOOL_OUTPUT_CHARS + 500))!
    expect(output).toBe('x'.repeat(MAX_TOOL_OUTPUT_CHARS) + '\n[output truncated]')
    expect(output.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 100)
  })
})
