import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string
const mainSource = new URL('../src/main/', import.meta.url)
const PROGRAM = `
import { app, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
app.setPath('userData', process.env.RESULT_USER_DATA)
const report = {}
let manager
let window
app.whenReady().then(async () => {
try {
  const { BrowserViewManager, BrowserRefLedgerStore, BrowserOperationJournal, BrowserOperationFileStore,
    BrowserResultArtifactStore, verifiedBrowserWorkspace } = await import('./owners.mjs')
  window = new BrowserWindow({width:800,height:600,show:true})
  manager = new BrowserViewManager(window, {defaultProfileId:()=> 'default',resolvePartition:()=> 'persist:probe'},
    new BrowserRefLedgerStore(join(app.getPath('userData'),'refs.json')),
    {rememberedSchemes:async()=>({}),rememberScheme:async()=>{},openExternal:()=>{}},
    new BrowserOperationJournal(new BrowserOperationFileStore(join(app.getPath('userData'),'operations.json'))),
    undefined, new BrowserResultArtifactStore(join(app.getPath('userData'),'results')))
  const workspace = verifiedBrowserWorkspace([{id:'workspace-native'}], 'workspace-native')
  await manager.create('browser-native',process.env.RESULT_PAGE,workspace)
  manager.setBounds('browser-native',{x:0,y:0,width:800,height:600})
  const waitDocument = async (url) => {
    const condition = "document.readyState === 'complete' && typeof globalThis.actionCount === 'number'"
    const code = 'while ((await pageInfo()).url !== '+JSON.stringify(url)+' || !(await js('+JSON.stringify(condition)+'))) await wait(20); return await pageInfo()'
    const ready = await manager.runScript('browser-native',code)
    if (ready.outcome.kind !== 'completed') throw new Error(JSON.stringify(ready.outcome))
    return ready.result
  }
  const opened = await waitDocument(process.env.RESULT_PAGE)
  if (process.env.RESULT_PHASE === 'capture') {
    const result = await manager.runScript('browser-native', 'await js("globalThis.actionCount += 1"); return {text:"中文🙂".repeat(150000)}')
    report.outcome = result.outcome
    report.reference = result.result
    report.operationId = result.runOperation.id
    report.initialNavigation = opened.navigationId
    report.actions = (await manager.runScript('browser-native','return await js("globalThis.actionCount")')).result
    await writeFile(process.env.RESULT_REFERENCE,JSON.stringify(report.reference))
    await manager.navigate('browser-native',process.env.RESULT_NEXT_PAGE)
    await waitDocument(process.env.RESULT_NEXT_PAGE)
    report.nextNavigation = (await manager.create('browser-native','about:blank',workspace)).navigationId
    const continued = await manager.runScript('browser-native','return await readResult('+JSON.stringify(report.reference)+',{offset:1,maxBytes:65536})')
    report.continuedOutcome = continued.outcome
    report.chunk = continued.result
    report.newDocumentActions = (await manager.runScript('browser-native','return await js("globalThis.actionCount")')).result
  } else {
    const reference = JSON.parse(await readFile(process.env.RESULT_REFERENCE,'utf8'))
    const result = await manager.runScript('browser-native','return await readResult('+JSON.stringify(reference)+',{offset:65537,maxBytes:37})')
    report.outcome = result.outcome
    report.chunk = result.result
    report.operationId = result.runOperation.id
    report.actions = (await manager.runScript('browser-native','return await js("globalThis.actionCount")')).result
  }
} catch (error) { report.error = error.stack || String(error) }
finally {
  await writeFile(process.env.RESULT_REPORT,JSON.stringify(report))
  manager?.close('browser-native')
  window?.destroy()
  app.quit()
}
})
`

it('native Browser owner returns large artifact, continues after navigation and recovers in a second Electron process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amux-result-native-'))
  try {
    const entry = join(directory, 'entry.ts')
    await writeFile(entry, ['browser-view-manager', 'browser-ref-ledger-store', 'browser-operation-journal', 'browser-result-artifact', 'browser-workspace-binding']
      .map(name => `export * from ${JSON.stringify(new URL(`${name}.ts`, mainSource).pathname)}`).join('\n'))
    const { build } = await import('vite')
    await build({ logLevel: 'error', build: { outDir: directory, emptyOutDir: false,
      lib: { entry, formats: ['es'], fileName: () => 'owners.mjs' }, rollupOptions: { external: ['electron', '@agentmux/core', /^node:/] } } })
    // Match Main's public package dependency, including Core's own file-URL assets.
    await symlink(new URL('../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir')
    await writeFile(join(directory, 'main.mjs'), PROGRAM)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module', main: 'main.mjs' }))
    for (const name of ['page.html', 'next.html']) await writeFile(join(directory, name), '<!doctype html><title>Native Result</title><script>globalThis.actionCount=0</script><button>Probe</button>')
    const run = async (phase: string): Promise<any> => {
      const reportPath = join(directory, `${phase}.json`)
      const env: NodeJS.ProcessEnv = { ...process.env, RESULT_USER_DATA: join(directory, 'userData'), RESULT_REFERENCE: join(directory, 'reference.json'),
        RESULT_REPORT: reportPath, RESULT_PHASE: phase, RESULT_PAGE: pathToFileURL(join(directory, 'page.html')).href,
        RESULT_NEXT_PAGE: pathToFileURL(join(directory, 'next.html')).href, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(ELECTRON, [directory], { env, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', text => { stderr = (stderr + text).slice(-8192) })
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Native result ${phase} probe timeout: ${stderr}`)) }, 45_000)
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('close', code => { clearTimeout(timer); resolve(code) })
      })
      expect(code, stderr).toBe(0)
      return JSON.parse(await readFile(reportPath, 'utf8'))
    }
    const captured = await run('capture')
    expect(captured.error).toBeUndefined()
    expect(captured.outcome.kind).toBe('completed')
    expect(captured.reference).toMatchObject({ kind: 'browser-result-artifact', operationId: captured.operationId,
      navigationId: captured.initialNavigation, workspaceId: 'workspace-native', browserId: 'browser-native' })
    expect(captured.reference.byteLength).toBeGreaterThan(1_000_000)
    expect(captured.actions).toBe(1)
    expect(captured.nextNavigation).not.toBe(captured.initialNavigation)
    expect(captured.continuedOutcome.kind).toBe('completed')
    expect(captured.chunk).toMatchObject({ reference: captured.reference, offset: 1, returnedBytes: 65536 })
    expect(captured.newDocumentActions).toBe(0)
    const recovered = await run('recover')
    expect(recovered.error).toBeUndefined()
    expect(recovered.outcome.kind).toBe('completed')
    expect(recovered.chunk).toMatchObject({ reference: captured.reference, offset: 65537, returnedBytes: 37 })
    expect(recovered.operationId).not.toBe(captured.operationId)
    expect(recovered.actions).toBe(0)
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 90_000)
