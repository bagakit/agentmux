import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const repository = resolve(import.meta.dirname, '../../..')
const desktop = join(repository, 'apps/desktop')
const desktopRequire = createRequire(join(desktop, 'package.json'))
const viteRequire = createRequire(desktopRequire.resolve('vite/package.json'))
const { parseAst } = viteRequire('rollup/parseAst')
const { resolveConfig } = await import(pathToFileURL(desktopRequire.resolve('electron-vite')).href)
const { config } = await resolveConfig({ root: desktop, configFile: join(desktop, 'electron.vite.config.ts') }, 'build')
const shims = config.main.plugins.flat(Infinity).filter((plugin: { name?: string }) => plugin?.name === 'vite:esm-shim')
expect(shims, 'Use the exact one production Main shim resolved by electron-vite').toHaveLength(1)
const shim = shims[0]
const acornRequire = createRequire(join(repository, 'packages/connectors/package.json'))
const acorn = await readFile(acornRequire.resolve('acorn').replace(/\.js$/, '.mjs'), 'utf8')
const imports = `import { basename } from 'node:path';\nimport { fileURLToPath } from 'node:url';\n`
const globals = `required: typeof require('node:fs').readFileSync, directory: __dirname, filename: __filename, imported: basename('first/last')`
const fixtures = [
  { name: 'the real Acorn dependency with import words in parser strings',
    code: imports + acorn + `\nconsole.log(JSON.stringify({ ${globals}, original: parse('import.meta.url', { ecmaVersion: 'latest', sourceType: 'module' }).body[0].expression.object.meta.name }))`,
    original: 'import' },
  { name: 'a normal quoted string after an unrelated import-looking comment',
    code: imports + `// import ignored from 'comment-only';\nconst marker = "ordinary import 'never-load' tail";\nconsole.log(JSON.stringify({ ${globals}, original: marker }))`,
    original: "ordinary import 'never-load' tail" }
]

it.each(fixtures)('the production Main ESM shim preserves $name', async ({ code, original }) => {
  expect(parseAst(code).body.filter((node: { type: string }) => node.type === 'ImportDeclaration')).toHaveLength(2)
  const rendered = await shim.renderChunk.call({ parse: parseAst }, code, { fileName: 'main-fixture.mjs' }, { format: 'es', sourcemap: true })
  expect(rendered, 'Actual CommonJS use requires the production shim').not.toBeNull()
  const generated = parseAst(rendered.code)
  expect(generated.body.filter((node: { type: string }) => node.type === 'ImportDeclaration').map((node: { source: { value: string } }) => node.source.value))
    .toEqual(['node:path', 'node:url', 'node:module'])
  expect(rendered.map.sources).toHaveLength(1)
  expect(rendered.map.mappings.length).toBeGreaterThan(0)
  const temporary = await mkdtemp(join(tmpdir(), 'agentmux-main-esm-shim-'))
  try {
    const output = join(temporary, 'main-fixture.mjs')
    await writeFile(output, rendered.code)
    const result = JSON.parse(execFileSync(process.execPath, [output], {
      cwd: temporary, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_PATH: '' }
    }))
    const canonicalOutput = await realpath(output)
    expect(result).toEqual({ required: 'function', directory: dirname(canonicalOutput), filename: canonicalOutput,
      imported: 'last', original })
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

it('keeps ESM without CommonJS use and CommonJS output unchanged', async () => {
  const code = `${imports}console.log(basename('path/value'))`
  expect(await shim.renderChunk.call({ parse: parseAst }, code, {}, { format: 'es', sourcemap: true })).toBeNull()
  expect(await shim.renderChunk.call({ parse: parseAst }, `console.log(require('node:fs'))`, {}, { format: 'cjs', sourcemap: true })).toBeNull()
})
