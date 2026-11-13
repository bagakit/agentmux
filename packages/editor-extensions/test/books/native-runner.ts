import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve, join, relative, dirname, basename } from 'node:path'
import { build, type Plugin } from 'vite'
import assert from 'node:assert/strict'
import { privatePackageSmokeEnvironment } from '../../../../apps/desktop/scripts/package-smoke-context.mjs'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from '../../../../apps/desktop/scripts/probe-process.mjs'

export type BookReport = { results: Record<string, { checks: number; failure?: string; facts?: Record<string, unknown> }>; actualBrowser: string; isolation: Record<string, string>; failure?: string }
const packageRoot = resolve(import.meta.dirname, '../..')
const changes = {
  security: ['src/books/security.ts', 'export function sanitizeBookDocument(doc: Document): void {', 'export function sanitizeBookDocument(doc: Document): void { return;'],
  release: ['src/books/resources.ts', '    URL.revokeObjectURL(url)', '    void url'],
  'read-all': ['src/books/archive.ts', 'const entries = (await reader.getEntries()).filter(entry => !entry.directory)', 'await source.read(0, source.size, signal); const entries = (await reader.getEntries()).filter(entry => !entry.directory)'],
  'shared-read': ['src/books/vendor/foliate/epub.js', 'const pending = this.#pending.get(href)', 'const pending = undefined'],
  cancellation: ['src/books/normalize.ts', "controller.abort(new DOMException('The book was closed', 'AbortError'))", 'void controller'],
} as const

export async function runBookProbe(): Promise<BookReport> {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-book-contracts-')), profile = join(root, 'profile'), output = join(root, 'renderer')
  const sourceHashes: Record<string, string> = {}, mutation = process.env.BOOKS_MUTATION as keyof typeof changes | undefined
  let mutationHits = 0
  let mutatedSource: { path: string; original: string; loaded: string } | undefined
  const plugin: Plugin = { name: 'actual-book-contract-sources', enforce: 'pre', transform(source, id) {
    const path = relative(packageRoot, id.split('?')[0]!)
    if (!path.startsWith('src/books/') && !path.startsWith('test/books/')) return
    const original = createHash('sha256').update(source).digest('hex')
    if (mutation && changes[mutation]?.[0] === path) {
      const [, needle, replacement] = changes[mutation]
      assert.equal(source.split(needle).length - 1, 1, 'One exact loaded mutation anchor')
      source = source.replace(needle, replacement); mutationHits++
      mutatedSource = { path, original, loaded: createHash('sha256').update(source).digest('hex') }
    }
    sourceHashes[path] = original
    return { code: source, map: null }
  } }
  try {
    if (mutation) assert.ok(changes[mutation], 'Known book source mutation')
    const kf8 = await readFile(resolve(import.meta.dirname, 'fixtures/alice-gutenberg-11.azw3'))
    sourceHashes['test/books/fixtures/alice-gutenberg-11.azw3'] = createHash('sha256').update(kf8).digest('hex')
    await build({ define: { __KF8_BASE64__: JSON.stringify(kf8.toString('base64')) }, configFile: false, root: packageRoot, base: './', logLevel: 'error', plugins: [plugin], worker: { format: 'es' },
      build: { outDir: output, emptyOutDir: true, lib: { entry: resolve(import.meta.dirname, 'browser-contracts.ts'), formats: ['iife'], name: 'BookContracts', fileName: () => 'book-contracts.js' },
        rollupOptions: { output: { inlineDynamicImports: true } } } })
    if (mutation) assert.equal(mutationHits, 1, 'The actual native bundle contains the source mutation')
    await writeFile(join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; connect-src blob:; img-src blob: data:; style-src \'unsafe-inline\' blob:"><script src="./book-contracts.js"></script>')
    const userData = join(profile, 'user-data'), runtimeRoot = join(root, 'runtime')
    const env = privatePackageSmokeEnvironment(process.env, { userData, runtimeRoot, readyFile: join(root, 'ready.json') })
    for (const directory of [env.HOME, env.TMPDIR, join(profile, 'app-data'), userData, join(profile, 'session-data')]) await mkdir(directory, { recursive: true })
    const reportFile = join(root, 'report.json'), main = join(root, 'main.cjs')
    await writeFile(main, `const {app,BrowserWindow}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const [page,profile,reportFile]=process.argv.slice(2), expected={home:process.env.HOME,appData:path.join(profile,'app-data'),userData:path.join(profile,'user-data'),sessionData:path.join(profile,'session-data')};
for(const [key,value] of Object.entries(expected)) app.setPath(key,value);
app.whenReady().then(async()=>{let report={};try{const isolation=Object.fromEntries(Object.keys(expected).map(key=>[key,app.getPath(key)]));assert.deepEqual(isolation,expected);const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});await win.loadFile(page);report=await win.webContents.executeJavaScript('runBookContracts()');report.isolation=isolation;}catch(error){report.failure=String(error.stack||error)}finally{await fs.writeFile(reportFile,JSON.stringify(report));app.exit(report.failure?1:0)}});`)
    const require = createRequire(import.meta.url)
    const outcome = await runProbeProcess(require('electron'), [main, join(output, 'index.html'), profile, reportFile], { temporaryRoot: root, cwd: packageRoot, env, timeoutMs: 45000 })
    const report = JSON.parse(await readFile(reportFile, 'utf8')) as BookReport
    const evidence = process.env.BOOKS_RECEIPT
    if (evidence) {
      await copyFile(join(output, 'book-contracts.js'), join(dirname(evidence), basename(evidence, '.json') + '-bundle.js'))
      await writeFile(evidence, JSON.stringify({ schema: 'agentmux.book-contracts.v1', sourceHashes, mutatedSource, runtimeBundleSha256: createHash('sha256').update(await readFile(join(output, 'book-contracts.js'))).digest('hex'), mutation: mutation ?? null, mutationHits, outcome, report }, null, 2))
    }
    assert.equal(outcome.exitCode, 0, report.failure)
    assert.equal(report.failure, undefined)
    assert.ok(Object.keys(sourceHashes).length > 0, 'The native renderer bundled actual package book sources')
    return report
  } finally {
    const remaining = await listProbeProcesses(-1, root)
    for (const pid of remaining) await signalOwnedProbeProcess(pid, root, 'SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
}
