import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dimensions } from './fixtures/settings-evaluation/analysis.mjs'

export function parseOptions(args) {
  const options = { assertions: [], sections: undefined, sizes: [[1280, 860]], modes: ['dark'], output: undefined, help: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help') { options.help = true; continue }
    if (arg === '--check-schema') continue // Every capture validates the full selected Renderer schema.
    if (!['--assert', '--sections', '--sizes', '--modes', '--output'].includes(arg)) throw new Error(`Unknown option: ${arg}`)
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
    if (arg === '--assert') {
      options.assertions = value === 'all' ? [...dimensions] : value.split(',')
      if (options.assertions.some(dimension => !dimensions.includes(dimension))) throw new Error(`Unknown presentation assertion: ${value}`)
    } else if (arg === '--sections') options.sections = value.split(',')
    else if (arg === '--modes') {
      options.modes = value.split(',')
      if (new Set(options.modes).size !== options.modes.length || options.modes.some(mode => !['dark', 'light'].includes(mode))) throw new Error('Modes must be unique dark/light values.')
    } else if (arg === '--sizes') {
      options.sizes = value.split(',').map(size => {
        if (!/^\d+x\d+$/.test(size)) throw new Error(`Invalid viewport size: ${size}`)
        const pair = size.split('x').map(Number)
        if (pair.some(number => number <= 0 || !Number.isSafeInteger(number))) throw new Error(`Invalid viewport size: ${size}`)
        return pair
      })
      if (new Set(options.sizes.map(size => size.join('x'))).size !== options.sizes.length) throw new Error('Viewport sizes must be unique.')
    } else options.output = resolve(value)
  }
  return options
}

async function compiledDigest(directory) {
  const hash = createHash('sha256')
  async function visit(path, prefix = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name), name = join(prefix, entry.name)
      if (entry.isDirectory()) await visit(child, name)
      else { hash.update(name); hash.update(await readFile(child)) }
    }
  }
  await visit(directory)
  return hash.digest('hex')
}

async function capture(options) {
  const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
  const fixture = join(import.meta.dirname, 'fixtures/settings-evaluation')
  const base = join(root, '.local/settings-evaluation')
  await mkdir(base, { recursive: true })
  const out = options.output ?? await mkdtemp(join(base, 'run-'))
  await mkdir(out, { recursive: true })
  if ((await readdir(out)).length) throw new Error('The output directory must be empty; preserve earlier capture evidence.')
  const require = createRequire(join(desktop, 'package.json'))
  const { build } = await import('vite')
  const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default
  const { radixOverlayAliases } = await import('../../../packages/client-ui/scripts/radix-overlay-aliases.ts')
  const { noteParsingAliases } = await import('../../../packages/client-ui/scripts/note-parsing-aliases.ts')
  const candidate = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    trackedDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: root })).digest('hex')
  }
  try {
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
      resolve: { alias: { ...radixOverlayAliases, ...noteParsingAliases, '@desktop': join(desktop, 'src') }, dedupe: ['react', 'react-dom'] },
      plugins: [react()], build: { outDir: join(out, 'compiled'), emptyOutDir: true, minify: false, sourcemap: false, target: 'esnext' } })
    candidate.compiledSha256 = await compiledDigest(join(out, 'compiled'))
    const code = await new Promise((done, fail) => {
      const child = spawn(require('electron'), [join(fixture, 'main.cjs')], { cwd: root, stdio: 'inherit',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, SETTINGS_EVALUATION_OUT: out, SETTINGS_EVALUATION_OPTIONS: JSON.stringify(options) } })
      const timeout = setTimeout(() => child.kill('SIGTERM'), 180000)
      child.on('close', code => { clearTimeout(timeout); done(code ?? 1) })
      child.on('error', error => { clearTimeout(timeout); fail(error) })
    })
    const receipt = JSON.parse(await readFile(join(out, 'receipt.json'), 'utf8'))
    receipt.candidate = candidate
    await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
    console.log(`Settings evaluation: ${join(out, 'receipt.json')}`)
    if (code) process.exitCode = 1
  } catch (error) {
    let receipt
    try { receipt = JSON.parse(await readFile(join(out, 'receipt.json'), 'utf8')) }
    catch { receipt = { scope: 'real-settings-renderer-with-preview-api', registered: [], rows: [], errors: [String(error.stack ?? error)] } }
    receipt.candidate = candidate
    await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
    console.error(`Settings evaluation failed: ${join(out, 'receipt.json')}`)
    throw error
  } finally {
    // Only this newly created, private capture directory is cleaned. Screenshots and receipt stay.
    for (const name of ['compiled', 'home', 'appData', 'userData', 'sessionData']) await rm(join(out, name), { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseOptions(process.argv.slice(2))
    if (options.help) console.log('Usage: node apps/desktop/scripts/capture-settings-evaluation.mjs [--check-schema] [--assert all|first-screen,type,language,jargon] [--sections ID,...] [--sizes 1280x860,640x860] [--modes dark,light] [--output EMPTY_DIRECTORY]\nEvery selected section is rendered through the real SettingsPanel with preview APIs. Business state is unverified; state-unavailable sections are named in the receipt. Capture is not aesthetic review.')
    else await capture(options)
  } catch (error) { console.error(error.stack ?? error); process.exitCode = 1 }
}
