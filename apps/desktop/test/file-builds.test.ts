import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import { FileBuilds } from '../src/main/file-builds'
import { WorkspaceFiles } from '../src/main/workspace-files'
import type { WorkspaceRecord } from '../src/shared/contracts'
import type { FileBuildRequest, FileBuildSnapshot } from '../src/shared/file-build'

let root: string, workspace: WorkspaceRecord, current: WorkspaceRecord, files: WorkspaceFiles, builds: FileBuilds, compiler: string
const local = new LocalExecutionHost()
const hostFor = (id: string): ExecutionHost => id === 'local' ? local : { id, kind: 'ssh', label: 'Remote', run: () => { throw new Error('Remote compiler must never fall back locally') }, dispose: async () => {} }
const request = (id: string, content = 'CURRENT DRAFT'): FileBuildRequest => ({ id, kind: 'latex', path: 'document.tex', content, resource: { hostId: workspace.hostId, path: workspace.path } })
async function finished(id: string): Promise<FileBuildSnapshot> {
  let snapshot = builds.inspect(id)!
  for (let attempt = 0; attempt < 500 && snapshot.status === 'running'; attempt++) { await new Promise(resolve => setTimeout(resolve, 10)); snapshot = builds.inspect(id)! }
  expect(snapshot.status).not.toBe('running')
  return snapshot
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'amx-file-build-test-')))
  workspace = { id: 'original', hostId: 'local', path: root, name: 'Original' } as WorkspaceRecord
  current = workspace
  files = new WorkspaceFiles(hostFor)
  await writeFile(join(root, 'document.tex'), 'DISK ORIGINAL')
  compiler = join(root, 'test-compiler')
  await writeFile(compiler, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
 const args=process.argv.slice(2),output=path.join(args[args.indexOf('--outdir')+1],'texput.pdf');
 console.log(JSON.stringify({cwd:process.cwd(),args,input,output,untrusted:process.env.TECTONIC_UNTRUSTED_MODE,pid:process.pid}));
 if(input==='FAIL'){console.error('actual diagnostic');process.exit(4)}
 if(input==='BADPDF'){fs.writeFileSync(output,'not PDF');return}
 if(input==='FLOOD'){process.stdout.write('x'.repeat(1024*1024+1));setInterval(()=>{},1000);return}
 if(input==='WAIT'){
  const child=cp.spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit','ipc']});child.once('message',()=>console.log('CHILD:'+child.pid));
  process.on('SIGTERM',()=>{console.log('TERM RECEIVED');process.exit(0)});setInterval(()=>{},1000);return;
 }
 fs.writeFileSync(output,'%PDF-1.7\\n'+input);
});`)
  await chmod(compiler, 0o755)
  builds = new FileBuilds(hostFor, () => current, files, { commands: { latex: compiler } })
})
afterEach(async () => { await builds.dispose(); await files.dispose(); await rm(root, { recursive: true, force: true }) })

describe('explicit original File build owner', () => {
  it('compiles the current draft on its original cwd, preserves disk and releases private artifacts', async () => {
    expect(builds.start(workspace, request('draft')).status).toBe('running')
    const result = await finished('draft')
    expect(result.status).toBe('succeeded')
    expect(Buffer.from(result.pdf!).toString()).toContain('CURRENT DRAFT')
    expect(await readFile(join(root, 'document.tex'), 'utf8')).toBe('DISK ORIGINAL')
    const fact = JSON.parse(result.log.trim())
    expect(fact.cwd).toBe(root)
    expect(fact.args).toEqual(['-X', 'compile', '--only-cached', '--untrusted', '--outdir', dirname(fact.output), '--print', '-'])
    expect(fact.untrusted).toBe('1')
    await expect(readFile(fact.output)).rejects.toThrow()
    result.pdf![0] = 0
    expect(builds.inspect('draft')!.pdf![0]).toBe(37)
    await builds.release('draft')
    expect(builds.inspect('draft')).toBeUndefined()
  })
  it('reports compiler diagnostics, malformed artifacts and bounded live output without overwriting Source', async () => {
    for (const content of ['FAIL', 'BADPDF', 'FLOOD']) {
      builds.start(workspace, request(content, content))
      const result = await finished(content)
      expect(result.status).toBe('failed')
      expect(result.pdf).toBeUndefined()
      if (content === 'FAIL') expect(result.log).toContain('actual diagnostic')
      if (content === 'BADPDF') expect(result.message).toMatch(/valid PDF/)
      if (content === 'FLOOD') expect(result.message).toMatch(/live log budget/)
    }
    expect(await readFile(join(root, 'document.tex'), 'utf8')).toBe('DISK ORIGINAL')
  })
  it('keeps a missing compiler and remote Host unavailable without a local fallback', async () => {
    const missing = new FileBuilds(hostFor, () => workspace, files, { commands: { latex: join(root, 'missing') } })
    try {
      missing.start(workspace, request('missing'))
      for (let i = 0; i < 100 && missing.inspect('missing')!.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(missing.inspect('missing')!.status).toBe('unavailable')
    } finally { await missing.dispose() }
    current = { ...workspace, hostId: 'ssh-original' }
    expect(builds.start(current, { ...request('remote'), resource: { hostId: current.hostId, path: current.path } }).status).toBe('unavailable')
    expect(() => builds.start(current, request('wrong-resource'))).toThrow(/Workspace changed/)
  })
  it('refuses source path escapes and outside symlinks through the existing WorkspaceFiles owner', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'amx-build-outside-'))
    try {
      await writeFile(join(outside, 'secret.tex'), 'secret')
      await symlink(join(outside, 'secret.tex'), join(root, 'outside.tex'))
      for (const path of ['../outside.tex', 'outside.tex']) {
        const id = `escape-${path}`; builds.start(workspace, { ...request(id), path })
        expect((await finished(id)).status).not.toBe('succeeded')
        expect(builds.inspect(id)!.pdf).toBeUndefined()
      }
    } finally { await rm(outside, { recursive: true, force: true }) }
  })
  it('confirms cancellation after the original process and its owned descendant close', async () => {
    builds.start(workspace, request('cancel', 'WAIT'))
    await expect.poll(() => builds.inspect('cancel')!.log, { timeout: 10_000, interval: 10, message: 'The compiler descendant must report its installed signal handler before cancellation' }).toContain('CHILD:')
    const running = builds.inspect('cancel')!
    expect(running.status).toBe('running')
    const pid = JSON.parse(running.log.split('\n')[0]!).pid
    const child = Number(running.log.match(/CHILD:(\d+)/)![1])
    const result = await builds.cancel('cancel')
    expect(result!.status).toBe('cancelled')
    expect(result!.log).toContain('TERM RECEIVED')
    expect(() => process.kill(pid, 0)).toThrow()
    for (let i = 0; i < 100; i++) { try { process.kill(child, 0); await new Promise(resolve => setTimeout(resolve, 10)) } catch { break } }
    expect(() => process.kill(child, 0)).toThrow()
    expect(result!.pdf).toBeUndefined()
  })
  it('invalidates in-flight setup on ABA rebind and releaseAll, then allows a new explicit build', async () => {
    let resume!: (path: string) => void
    const controlled = new FileBuilds(hostFor, () => current, { localPathForSystemOpen: () => new Promise(resolve => { resume = resolve }) }, { commands: { latex: compiler } })
    try {
      controlled.start(workspace, request('aba'))
      current = { ...workspace, path: join(root, 'changed') }; controlled.invalidateWorkspace(workspace.id); current = workspace
      resume(join(root, 'document.tex'))
      for (let i = 0; i < 300 && controlled.inspect('aba')!.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(controlled.inspect('aba')!.status).toBe('failed')
      expect(controlled.inspect('aba')!.pdf).toBeUndefined()
      controlled.start(workspace, request('released'))
      const released = controlled.releaseAll()
      resume(join(root, 'document.tex'))
      await released
      expect(controlled.inspect('released')).toBeUndefined()
    } finally { await controlled.dispose() }
    builds.start(workspace, request('new'))
    expect((await finished('new')).status).toBe('succeeded')
  })
})
