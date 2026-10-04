import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const desktop = resolve(import.meta.dirname, '..'), require = createRequire(join(desktop, 'package.json'))
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const argument = name => { const index = process.argv.indexOf(name); assert.ok(index >= 0 && process.argv[index + 1], `Explicit ${name} is required; this proof never installs or downloads a compiler.`); return resolve(process.argv[index + 1]) }
const tectonic = argument('--tectonic'), typst = argument('--typst'), cache = argument('--tectonic-cache')
assert.match(execFileSync(tectonic, ['--version'], { encoding: 'utf8' }), /Tectonic 0\.17\.0/)
assert.match(execFileSync(typst, ['--version'], { encoding: 'utf8' }), /typst 0\.15\.1/)
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'amx-build-engines-')))
const results = []
let owner, files
try {
  const runtime = join(temporary, 'out/main/runtime.mjs')
  await mkdir(dirname(runtime), { recursive: true })
  await mkdir(join(temporary, 'resources/bin'), { recursive: true })
  await cp(join(desktop, 'resources/bin/agentmux-workspace-move'), join(temporary, 'resources/bin/agentmux-workspace-move'))
  await symlink(join(desktop, 'node_modules'), join(temporary, 'node_modules'))
  await build({ stdin: { contents: `export { FileBuilds } from './src/main/file-builds.ts'; export { WorkspaceFiles } from './src/main/workspace-files.ts'; export { LocalExecutionHost } from '@agentmux/core';`, resolveDir: desktop }, outfile: runtime, bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['@agentmux/core'] })
  const { FileBuilds, WorkspaceFiles, LocalExecutionHost } = await import(pathToFileURL(runtime).href)
  const host = new LocalExecutionHost(), root = join(temporary, 'original'), subdir = join(root, 'chapter')
  await mkdir(subdir, { recursive: true })
  await mkdir(join(root, 'assets'))
  await writeFile(join(subdir, 'draft.tex'), 'DISK TEX ORIGINAL')
  await writeFile(join(subdir, 'sibling.tex'), 'TEX SIBLING RESOURCE')
  await writeFile(join(subdir, 'draft.typ'), 'DISK TYPST ORIGINAL')
  await writeFile(join(subdir, 'sibling.typ'), 'TYPST SIBLING RESOURCE')
  await writeFile(join(root, 'parent.typ'), 'TYPST PARENT RESOURCE')
  await writeFile(join(root, 'root.typ'), 'TYPST ROOT RESOURCE')
  await writeFile(join(root, 'assets/image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>')
  const workspace = { id: 'original', hostId: 'local', path: root, name: 'Engine proof' }
  files = new WorkspaceFiles(() => host)
  owner = new FileBuilds(() => host, () => workspace, files, { commands: { latex: tectonic, typst }, env: { TECTONIC_CACHE_DIR: cache } })
  const pdfEngine = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href)
  async function run(id, kind, content, expected) {
    const start = performance.now()
    assert.equal(owner.start(workspace, { id, kind, path: `chapter/draft.${kind === 'latex' ? 'tex' : 'typ'}`, content, resource: { hostId: 'local', path: root } }).status, 'running')
    let snapshot
    for (;;) {
      snapshot = owner.inspect(id)
      if (snapshot.status !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(snapshot.status, expected ? 'succeeded' : 'failed', `${id}: ${snapshot.message}\n${snapshot.log}`)
    const result = { id, status: snapshot.status, elapsedMs: performance.now() - start, logBytes: Buffer.byteLength(snapshot.log), pdfBytes: snapshot.pdf?.byteLength ?? 0 }
    if (expected) {
      const task = pdfEngine.getDocument({ data: snapshot.pdf.slice(), useSystemFonts: false, useWorkerFetch: false })
      try {
        const document = await task.promise, page = await document.getPage(1), text = await page.getTextContent()
        const visible = text.items.map(item => 'str' in item ? item.str : '').join(' ')
        for (const needle of expected) assert.ok(visible.includes(needle), `${id} actual PDF text missing ${needle}: ${visible}`)
        if (kind === 'typst') { const operators = await page.getOperatorList(); assert.ok(operators.fnArray.length > 0) }
        result.text = visible
      } finally { await task.destroy() }
      if (kind === 'latex') assert.doesNotMatch(snapshot.log, /downloading /i, 'Production compile must use already cached resources.')
    } else { assert.equal(snapshot.pdf, undefined); assert.ok(snapshot.log.length > 0) }
    const outputMatch = snapshot.log.match(/Writing `([^`]+texput\.pdf)`/)
    if (outputMatch) await assert.rejects(access(outputMatch[1]))
    await owner.release(id)
    assert.equal(owner.inspect(id), undefined)
    results.push(result)
  }
  await run('latex-current-draft', 'latex', '\\documentclass{article}\\begin{document}CURRENT TEX DRAFT \\input{sibling.tex}\\end{document}', ['CURRENT TEX DRAFT', 'TEX SIBLING RESOURCE'])
  await run('latex-error', 'latex', '\\documentclass{article}\\begin{document}\\ThisCommandDoesNotExist\\end{document}')
  await run('typst-current-draft', 'typst', 'CURRENT TYPST DRAFT\n\n#include "sibling.typ"\n#include "../parent.typ"\n#include "/root.typ"\n#image("/assets/image.svg")', ['CURRENT TYPST DRAFT', 'TYPST SIBLING RESOURCE', 'TYPST PARENT RESOURCE', 'TYPST ROOT RESOURCE'])
  await run('typst-error', 'typst', '#include "missing-resource.typ"')
  assert.equal(await readFile(join(subdir, 'draft.tex'), 'utf8'), 'DISK TEX ORIGINAL')
  assert.equal(await readFile(join(subdir, 'draft.typ'), 'utf8'), 'DISK TYPST ORIGINAL')
  await owner.releaseAll()
  console.log(JSON.stringify({ passed: true, versions: { tectonic: '0.17.0', typst: '0.15.1' }, results, sourcePreserved: true }))
} finally { await owner?.dispose(); await files?.dispose(); await rm(temporary, { recursive: true, force: true }) }
