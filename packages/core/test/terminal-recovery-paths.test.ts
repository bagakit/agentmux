import { isAbsolute, win32 } from 'node:path'
import { expect, it, vi } from 'vitest'
import { parseTerminalRecoveryInput } from '../src/terminal-recovery.js'

const input = { expectedRun: { runId: 'original-run' }, runtimeId: 'original-runtime', operationId: 'original-operation' }

it('validates terminal recovery paths with the host path semantics', () => {
  for (const workspacePath of ['/workspace', '//server/share', 'relative/path', '../other', 'C:\\workspace', 'C:/workspace', '\\workspace']) {
    const parse = () => parseTerminalRecoveryInput({ ...input, workspacePath })
    if (isAbsolute(workspacePath)) expect(parse().workspacePath).toBe(workspacePath)
    else expect(parse).toThrow()
  }
})

it('preserves Windows host path semantics', () => {
  vi.stubGlobal('process', new Proxy(process, {
    get(target, property, receiver) {
      return property === 'platform' ? 'win32' : Reflect.get(target, property, receiver)
    }
  }))
  try {
    for (const workspacePath of ['/workspace', 'C:\\workspace', 'C:/workspace', '\\server\\share', 'C:relative', 'relative/path']) {
      const parse = () => parseTerminalRecoveryInput({ ...input, workspacePath })
      if (win32.isAbsolute(workspacePath)) expect(parse().workspacePath).toBe(workspacePath)
      else expect(parse).toThrow()
    }
  } finally {
    vi.unstubAllGlobals()
  }
})

it('accepts absolute paths and rejects relative paths without Node globals', () => {
  vi.stubGlobal('process', undefined)
  try {
    for (const workspacePath of ['/workspace', 'C:\\workspace', '\\server\\share']) {
      expect(parseTerminalRecoveryInput({ ...input, workspacePath }).workspacePath).toBe(workspacePath)
    }
    for (const workspacePath of ['relative/path', '../other', 'C:relative']) {
      expect(() => parseTerminalRecoveryInput({ ...input, workspacePath })).toThrow()
    }
  } finally {
    vi.unstubAllGlobals()
  }
})
