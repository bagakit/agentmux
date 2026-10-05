import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BrowserOperationFileStore, BrowserOperationJournal } from '../src/main/browser-operation-journal.js'

const require = createRequire(new URL('../../../packages/core/package.json', import.meta.url))
const { build } = require('esbuild')
const roots: string[] = [], children: ChildProcess[] = []
let bundle: string, buildRoot: string
beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), 'amx-browser-first-source-'))
  bundle = join(buildRoot, 'journal.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../src/main/browser-operation-journal.ts', import.meta.url))],
    outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
    alias: { '@agentmux/core': fileURLToPath(new URL('../../../packages/core/src/durable-write.ts', import.meta.url)) } })
})
afterAll(async () => { if (buildRoot) await rm(buildRoot, { recursive: true, force: true }) })
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGKILL'); await exited
  }))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function location() {
  const root = await mkdtemp(join(tmpdir(), 'amx-browser-first-publication-')); roots.push(root)
  return { root, path: join(root, 'browser-operation-journal.json') }
}
function owner(path: string, mode: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/browser-operation-first-publication.mjs', import.meta.url)), bundle, path, mode],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  children.push(child)
  let stderr = ''
  child.stderr!.on('data', value => { stderr += value })
  const messages: any[] = []
  child.on('message', value => { messages.push(value) })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => { resolve({ code, signal }) })
  })
  return { child, exited, resume() { child.send('continue') }, async wait(type: string): Promise<any> {
    const available = messages.findIndex(value => value.type === type)
    if (available >= 0) return messages.splice(available, 1)[0]
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Child did not reach ${type}: ${stderr}`)) }, 10_000)
      const message = (value: any) => { if (value.type === type) { cleanup(); messages.splice(messages.indexOf(value), 1); resolve(value) } }
      const exit = () => { cleanup(); reject(new Error(`Child exited before ${type}: ${stderr}`)) }
      const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit) }
      child.on('message', message); child.once('exit', exit)
    })
  } }
}
async function readInNewOwner(path: string) {
  const reader = owner(path, 'read'), result = await reader.wait('read')
  expect(await reader.exited).toEqual({ code: 0, signal: null })
  return result
}

describe('Browser journal first publication is atomic and exclusive', () => {
  it.each(['reserve', 'before-publish'])('a killed %s candidate leaves the original path absent and a new OS owner can save', async mode => {
    const f = await location(), interrupted = owner(f.path, mode)
    const point = await interrupted.wait(mode === 'reserve' ? 'reserved' : 'before-publish')
    expect(point.candidate).not.toBe(f.path)
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
    if (mode === 'before-publish') {
      expect(point.trace).toEqual(['file-sync:start', 'file-sync:done'])
      expect((await new BrowserOperationFileStore(point.candidate).load())!.operations).toMatchObject([{ id: 'first' }])
    }
    interrupted.child.kill('SIGKILL')
    expect(await interrupted.exited).toEqual({ code: null, signal: 'SIGKILL' })
    const replacement = owner(f.path, 'normal'), saved = await replacement.wait('saved')
    expect(await replacement.exited).toEqual({ code: 0, signal: null })
    expect(saved.warning).toBeUndefined()
    expect(saved.trace).toEqual(['file-sync:start', 'file-sync:done', 'published', 'directory-sync:start', 'directory-sync:done'])
    const reopened = await readInNewOwner(f.path)
    expect(reopened.pid).not.toBe(saved.pid)
    expect(reopened.document.operations).toMatchObject([{ id: 'first', summary: 'First original operation' }])
  })

  it('a killed publisher leaves a complete first delta readable by a different OS owner', async () => {
    const f = await location(), interrupted = owner(f.path, 'after-publish')
    const point = await interrupted.wait('after-publish')
    expect(point.trace).toEqual(['file-sync:start', 'file-sync:done', 'published'])
    interrupted.child.kill('SIGKILL'); await interrupted.exited
    const reopened = await readInNewOwner(f.path)
    expect(reopened.pid).not.toBe(point.pid)
    expect(reopened.document.operations).toMatchObject([{ id: 'first', summary: 'First original operation' }])
    expect(reopened.document.events.map((event: { type: string }) => event.type)).toEqual(['operation-started'])
  })

  it('a failed first file fsync keeps healthy work and its original pending delta for retry', async () => {
    const f = await location(), writer = owner(f.path, 'fail-sync')
    const failed = await writer.wait('failed')
    expect(failed.canonicalExists).toBe(false)
    expect(failed.live).toMatchObject({ id: 'first', phase: 'preparing' })
    expect(failed.warning).toContain('first journal fsync failed')
    writer.resume()
    const saved = await writer.wait('saved'); expect(await writer.exited).toEqual({ code: 0, signal: null })
    expect(saved.warning).toBeUndefined()
    const reopened = await readInNewOwner(f.path)
    expect(reopened.document.operations).toMatchObject([{ id: 'first', steps: [{ sequence: 1, method: 'snapshot' }] }])
    expect(reopened.document.events.map((event: { type: string }) => event.type)).toEqual(['operation-started', 'step-started'])
    expect(await readdir(f.root)).toEqual(['browser-operation-journal.json'])
  })

  it('exclusive publication preserves a concurrent first owner and retries only the live facts', async () => {
    const f = await location(), writer = owner(f.path, 'race')
    await writer.wait('before-publish')
    const winner = new BrowserOperationJournal(new BrowserOperationFileStore(f.path))
    await winner.start({ id: 'winner', browserId: 'other-browser', operator: { id: 'person', name: 'Person' }, summary: 'Concurrent original history', url: 'https://other.invalid/' })
    const original = await readFile(f.path)
    writer.resume()
    const failed = await writer.wait('failed')
    expect(await readFile(f.path)).toEqual(original)
    expect(failed.warning).toContain('EEXIST')
    expect(failed.live).toMatchObject({ id: 'first', phase: 'preparing' })
    expect((await readInNewOwner(f.path)).document.operations.map((operation: { id: string }) => operation.id)).toEqual(['winner'])
    writer.resume()
    const saved = await writer.wait('saved'); expect(await writer.exited).toEqual({ code: 0, signal: null })
    expect(saved.warning).toBeUndefined()
    expect((await readInNewOwner(f.path)).document.operations).toMatchObject([
      { id: 'winner', summary: 'Concurrent original history', steps: [] }, { id: 'first', steps: [{ sequence: 1, method: 'snapshot' }] }
    ])
  })
})
