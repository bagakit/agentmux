import { expect, it } from 'vitest'
import { isAbsolute } from 'node:path'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { isAbsoluteNativePath, normalizeNativeTranscriptPath } from '../src/agent-native-locator.js'
import { parseAgentNativeResumeSource } from '../src/agent-native-sessions.js'

const source = { nativeHandle: { kind: 'provider', providerId: 'fixture-provider', sessionId: 'original-native', transcriptPath: '/native/original.jsonl' }, workspacePath: '/original-work', revision: 'a'.repeat(64) }
it('keeps original Node absolute-path and exact native-locator semantics without normalizing a workspace', () => {
  for (const value of ['', '/', '//host/share', '/work with spaces ', 'relative/work', 'C:/work', 'C:\\work', '\\host\\share', '\\rooted', 'C:relative']) expect(isAbsoluteNativePath(value)).toBe(isAbsolute(value))
  expect(parseAgentNativeResumeSource(source)).toEqual(source)
  expect(parseAgentNativeResumeSource({ ...source, workspacePath: '/work with spaces ' }).workspacePath).toBe('/work with spaces ')
  expect(normalizeNativeTranscriptPath('/native/original.jsonl')).toBe('/native/original.jsonl')
  for (const value of ['relative/work', '/work\nother', '/work\0other']) expect(() => parseAgentNativeResumeSource({ ...source, workspacePath: value })).toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_NATIVE_RESUME_SOURCE' }))
})

it('the actual public Takeover contract bundles and executes managed and native-only source decoding in a browser realm', async () => {
  const entry = new URL('../src/agent-takeover.ts', import.meta.url).pathname
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'OriginalTakeover', metafile: true, logLevel: 'silent' })
  expect(Object.keys(result.metafile!.inputs).some(path => path.endsWith('/agent-native-sessions.ts'))).toBe(true)
  const inputs = [
    { hostId: 'original-host', expectedRuntimeId: 'original-core', agentSessionId: 'original-session', organization: null },
    { hostId: 'original-host', expectedRuntimeId: 'original-core', nativeSource: source, executorId: 'original-executor', organization: null },
    { hostId: 'original-windows-host', nativeSource: { ...source, nativeHandle: { ...source.nativeHandle, transcriptPath: 'C:\\native\\original.jsonl' }, workspacePath: 'C:\\original-work' }, executorId: 'original-executor', organization: null }
  ]
  const decoded = runInNewContext(result.outputFiles[0]!.text + ';JSON.stringify(JSON.parse(inputs).map(value => OriginalTakeover.parseAgentTakeoverSource(value)))', { TextEncoder, inputs: JSON.stringify(inputs) })
  expect(JSON.parse(decoded)).toEqual(inputs)
  const original = await readFile(new URL('../src/agent-native-sessions.ts', import.meta.url), 'utf8')
  await expect(build({ entryPoints: [entry], bundle: true, write: false, platform: 'browser', logLevel: 'silent', plugins: [{ name: 'restore-node-native-parser-import', setup(builder) {
    builder.onLoad({ filter: /\/agent-native-sessions\.ts$/ }, () => ({ contents: original.replace("import { isAbsoluteNativePath } from './agent-native-locator.js'", "import { isAbsolute as isAbsoluteNativePath } from 'node:path'"), loader: 'ts' }))
  } }] })).rejects.toThrow(/node:path/)
})
