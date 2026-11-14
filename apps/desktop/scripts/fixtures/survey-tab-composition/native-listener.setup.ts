import { createRequire, syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, URL as SourceURL } from 'node:url'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterAll, expect } from 'vitest'

// The listener is forked outside Vite. Install before Core imports, retain real IPC,
// and resolve only this candidate package's shipped asset to its original Source.
const native = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')
const originalFork = native.fork
const sourceRoot = fileURLToPath(new SourceURL('../../../../../', import.meta.url))
const asset = resolve(sourceRoot, 'packages/core/dist/control-endpoint-listener-worker.js')
const source = resolve(sourceRoot, 'packages/core/src/control-endpoint-listener-worker.ts')
const sha256 = createHash('sha256').update(readFileSync(source)).digest('hex')
const observed: { identity: boolean; handles: number }[] = []
const log = (value: object) => { if (process.env.SURVEY_COMPOSITION_LISTENER_TRACE) appendFileSync(process.env.SURVEY_COMPOSITION_LISTENER_TRACE, JSON.stringify(value) + '\n') }
native.fork = ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) => {
  if (String(path) !== asset) return originalFork(path, args, options)
  const record = { identity: false, handles: 0 }; observed.push(record)
  log({ kind: 'fork', originalPath: String(path), source, sha256, args, execArgv: options.execArgv, stdio: options.stdio })
  const child = originalFork(source, args, options)
  child.on('message', (message: unknown, handle: unknown) => {
    if (message && typeof message === 'object' && 'identity' in message) record.identity = true
    if (handle) ++record.handles
    log({ kind: 'message', identity: record.identity, hasHandle: Boolean(handle) })
  })
  child.on('exit', (code, signal) => log({ kind: 'exit', code, signal }))
  return child
}) as typeof native.fork
syncBuiltinESMExports()
afterAll(() => {
  native.fork = originalFork; syncBuiltinESMExports()
  log({ kind: 'restored', restored: native.fork === originalFork, observed })
  expect(native.fork).toBe(originalFork)
  for (const call of observed) expect(call.identity).toBe(true)
})
