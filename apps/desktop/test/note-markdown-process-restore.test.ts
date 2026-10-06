// @vitest-environment node
import { beforeAll, afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
const output = resolve('.tmp/note-markdown-restore/renderer/process'), worker = join(output, 'worker.mjs'), helper = resolve('.tmp/note-markdown-restore/resources/bin/agentmux-workspace-move')
const directories: string[] = []
beforeAll(async () => {
  await mkdir(output, { recursive: true })
  await symlink(resolve('packages/core/node_modules'), join(output, 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
  await mkdir(resolve('.tmp/note-markdown-restore/resources/bin'), { recursive: true })
  if (process.platform === 'darwin') execFileSync('xcrun', ['clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', 'apps/desktop/native/workspace-move.c', '-o', helper])
  const { build } = createRequire(resolve('packages/core/package.json'))('esbuild') as typeof import('../../../packages/core/node_modules/esbuild')
  const alias: Record<string, string> = { '@agentmux/layout': resolve('packages/layout/src/index.ts') }
  for (const pkg of ['core', 'demand']) {
    const manifest = JSON.parse(readFileSync(resolve('packages', pkg, 'package.json'), 'utf8'))
    for (const [key, value] of Object.entries(manifest.exports) as [string, { import?: string }][]) if (value.import) alias[key === '.' ? `@agentmux/${pkg}` : `@agentmux/${pkg}/${key.slice(2)}`] = resolve('packages', pkg, value.import.replace('./dist/', pkg === 'demand' ? './' : './src/').replace(/\.js$/, '.ts'))
  }
  const compiled = await build({ entryPoints: ['apps/desktop/test/helpers/note-conversion-process-worker.ts'], outfile: worker, bundle: true, platform: 'node', format: 'esm', alias, metafile: true, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, loader: { '.css': 'empty', '.png': 'dataurl' }, logLevel: 'silent',
    plugins: [{ name: 'non-authoritative-gui-module-warming', setup(build) {
      build.onResolve({ filter: /file-surface-loading(?:\.ts)?$/ }, () => ({ path: 'warming', namespace: 'presentation-only' }))
      build.onLoad({ filter: /.*/, namespace: 'presentation-only' }, args => ({ contents: args.path === 'browser-worker' ? 'export default "unused-browser-worker"' : 'export function prepareFileSurface() {}', loader: 'js' }))
    } }, { name: 'same-client-ui-source', setup(build) {
      build.onResolve({ filter: /^@agentmux\/client-ui\// }, args => {
        const manifest = JSON.parse(readFileSync(resolve('packages/client-ui/package.json'), 'utf8'))
        const key = './' + args.path.slice('@agentmux/client-ui/'.length)
        const pattern = Object.keys(manifest.exports).filter(key => key.includes('*')).sort((a, b) => b.length - a.length).find(pattern => key.startsWith(pattern.slice(0, -1)))!
        const entry = manifest.exports[key] ?? manifest.exports[pattern]
        const source = typeof entry === 'string' ? entry : entry.browser ?? entry.types
        return { path: resolve('packages/client-ui', source.replace('*', key.slice(pattern?.length - 1))) }
      })
      build.onResolve({ filter: /\?(url|worker)$/ }, () => ({ path: 'browser-worker', namespace: 'presentation-only' }))
    } }, { name: 'original-package-externals', setup(build) {
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (Object.hasOwn(alias, args.path)) return { path: alias[args.path]! }
        if (args.path.startsWith('node:')) return { path: args.path, external: true }
        if (args.path.startsWith('@agentmux/')) {
          const [name, ...subpath] = args.path.slice('@agentmux/'.length).split('/') as [string, ...string[]]
          const manifest = JSON.parse(readFileSync(resolve('packages', name, 'package.json'), 'utf8'))
          const entry = manifest.exports[subpath.length ? './' + subpath.join('/') : '.']
          return { path: resolve('packages', name, typeof entry === 'string' ? entry : entry.import), external: true }
        }
        const installed = createRequire(join(args.resolveDir, 'package.json')).resolve(args.path), esm = installed.replace(/\.js$/, '.mjs')
        return { path: args.path.startsWith('@tiptap/') ? installed.replace(/\.cjs$/, '.js') : existsSync(esm) ? esm : installed, external: !args.path.endsWith('.css') }
      })
    } }] })
  const inputs = Object.fromEntries(Object.keys(compiled.metafile!.inputs).filter(path => /^(apps|packages)\//u.test(path)).map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]))
  for (const path of ['apps/desktop/native/workspace-move.c', 'apps/desktop/test/note-markdown-process-restore.test.ts']) inputs[path] = createHash('sha256').update(readFileSync(path)).digest('hex')
  await writeFile(join(output, 'compiled-inputs.json'), JSON.stringify(inputs, null, 2))
}, 30000)
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
function launch(mode: string, directory: string): Promise<any> {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, [worker, mode, directory, helper], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk)
    child.once('error', no); child.once('close', code => { try { if (code !== 0) throw new Error(stderr); yes(JSON.parse(stdout)) } catch (error) { no(error) } })
  })
}
it('restores the same converted workface in a second real process, retaining the old unknown write and later draft without replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'note-markdown-process-')); directories.push(directory)
  const first = await launch('write', directory), second = await launch('read', directory)
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ first, second, boundary: 'Two real Node processes, original Host/Files/SQLite/Spatial/Renderer initialize+persist owners; Chromium flush and speculative GUI warming are host-boundary adapters, no native user Run operations.' }, null, 2))
  expect(first.pid).not.toBe(second.pid)
  expect(first.writes).toBe(1); expect(second.writes).toBe(0)
  expect(second.tab.id).toBe('original-tab'); expect(second.tab.layout).toEqual(first.tab.layout)
  expect(second.tab.regions['original-region']).toMatchObject({ regionId: 'original-region', kind: 'file', path: 'original.note.md' })
  expect(second.graph.tabs).toEqual(first.graph.tabs); expect(second.graph.tabLayouts).toEqual(first.graph.tabLayouts)
  expect(second.documents).toEqual(first.documents)
  expect(second.documents.content).toContain('LATER UNSAVED INPUT')
  expect(second.documents.noteConversion.unconfirmedWrite.content).toContain('ORIGINAL UNKNOWN SENT')
  expect(second.documents.noteConversion.unconfirmedWrite.content).not.toContain('LATER UNSAVED INPUT')
  expect(second.documents.revision).toBe(second.documents.noteConversion.unconfirmedWrite.expectedRevision)
  expect(second.dirty).toBe(true)
  expect(second.body).toContain('ORIGINAL UNKNOWN SENT'); expect(second.body).not.toContain('LATER UNSAVED INPUT')
  expect(second.selected).toEqual(first.selected); expect(second.canvas).toEqual(first.canvas)
  expect(second.catalog.pages['same-note'].followers).toEqual(first.catalog.pages['same-note'].followers)
  expect(second.attribution.status).toBe('recorded')
  expect(second.attribution.blocks['same-block'].created.actor.id).toBe('original-agent-session')
}, 30000)
