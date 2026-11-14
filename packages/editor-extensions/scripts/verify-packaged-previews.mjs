import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const extension = resolve(import.meta.dirname, '..')
const { build } = await import(pathToFileURL(createRequire(import.meta.url).resolve('vite')).href)

export async function verifyPackagedPreviews(runDesktopConsumer) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'editor-previews-')))
  const packageFolder = join(temporary, 'node_modules/@agentmux/editor-extensions')
  const notebook = join(packageFolder, 'src/ui/NotebookFilePreview.tsx')
  const entry = join(temporary, 'consumer.ts')
  try {
    const [archive] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
      { cwd: extension, encoding: 'utf8', timeout: 60_000 }))
    await mkdir(packageFolder, { recursive: true })
    const archivePath = join(temporary, archive.filename)
    execFileSync('tar', ['-xzf', archivePath, '--strip-components=1', '-C', packageFolder], { timeout: 20_000 })
    // Dependencies are the already installed, locked workspace packages. The editor module and CSS are the archive's files.
    await symlink(join(extension, 'node_modules'), join(packageFolder, 'node_modules'))
    await writeFile(entry, [
      "export { NotebookFilePreview } from '@agentmux/editor-extensions/ui/NotebookFilePreview'",
      "export { PdfReader } from '@agentmux/editor-extensions/pdf'"
    ].join('\n'))

    async function bundle() {
      const modules = new Set()
      const result = await build({ configFile: false, root: temporary, logLevel: 'error', esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
        plugins: [{ name: 'preview-package-boundaries', transform(_source, id) { modules.add(id) } }],
        build: { write: false, target: 'es2022', rollupOptions: { input: entry, preserveEntrySignatures: 'strict' } }
      })
      const output = (Array.isArray(result) ? result : [result]).flatMap(item => item.output)
      assert.ok(output.some(item => item.type === 'chunk' && item.exports.includes('NotebookFilePreview') && item.exports.includes('PdfReader')))
      const css = output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => String(item.source)).join('\n')
      assert.match(css, /\.notebook-preview__cell\b/u)
      assert.match(css, /\.pdf-content\b/u)
      assert.match(css, /\.small-button\b/u)
      assert.match(css, /\.md-code\b/u)
      assert.ok(modules.has(notebook), 'The archive supplied the real notebook preview')
      assert.ok(modules.has(join(packageFolder, 'src/pdf/PdfReader.tsx')), 'The archive supplied the real PDF preview')
      assert.ok(![...modules].some(id => /\/client-ui\/(?:src|dist)\/index\.[jt]s$/u.test(id)), 'The packaged preview consumed the root Client UI barrel')
      return output.length
    }

    const outputs = await bundle()
    await runDesktopConsumer(packageFolder)
    const original = await readFile(notebook, 'utf8')
    const named = "'@agentmux/client-ui/components/AgentMarkdown'"
    assert.equal(original.split(named).length, 2)
    await writeFile(notebook, original.replace(named, "'@agentmux/client-ui'"))
    await assert.rejects(bundle(), /Missing "\." specifier in "@agentmux\/client-ui" package/u)
    await writeFile(notebook, original)
    assert.equal(await bundle(), outputs)
    return { archiveSHA256: createHash('sha256').update(await readFile(archivePath)).digest('hex'), outputs,
      mutation: 'rejected unregistered root Client UI entry', restored: true, privateWorkspaceDependencies: true }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
