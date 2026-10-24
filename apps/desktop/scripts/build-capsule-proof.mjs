import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, mkdir, writeFile, realpath, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(desktop, '../..')
const require = createRequire(join(desktop, 'package.json'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const packages = ['identity', 'capsule', 'diagnostic-evidence', 'git', 'relay', 'demand', 'core', 'connectors', 'client-ui']
async function files(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []))).flat()
}
async function hashes(paths, root = repository) {
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [relative(root, path), sha(await readFile(path))])))
}
async function command(name, executable, args, cwd = repository) {
  process.stdout.write(`capsule-build: ${name}\n`)
  await new Promise((done, fail) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: 'inherit' })
    child.once('error', fail)
    child.once('exit', (code, signal) => code === 0 ? done() : fail(new Error(`${name} failed: ${signal ?? code}`)))
  })
}

/** Build actual product consumers; the sole overlay keeps this private window from taking focus. */
export async function buildCapsuleProof(output = join(repository, '.tmp/capsule-native-build/out')) {
  output = resolve(output)
  // This is the original App prebuild, needed by real workspace operations in Main.
  await command('workspace move helper', process.execPath, [join(desktop, 'scripts/build-workspace-move-helper.mjs')])
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'package.json'), JSON.stringify({ type: 'module' }) + '\n')
  const dependencyRoot = join(desktop, 'node_modules')
  try { await symlink(dependencyRoot, join(output, 'node_modules'), 'dir') }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  assert.equal(await realpath(join(output, 'node_modules')), await realpath(dependencyRoot), 'Original Desktop dependency layout')
  const assets = ['resources', 'browser-extension']
  for (const name of assets) {
    const target = join(desktop, name), link = join(dirname(output), name)
    try { await symlink(target, link, 'dir') }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    assert.equal(await realpath(link), await realpath(target), 'Original App-relative resource layout: ' + name)
  }
  const sourcePaths = [join(repository, 'pnpm-lock.yaml'), join(repository, 'package.json'), join(desktop, 'package.json'),
    fileURLToPath(import.meta.url), join(desktop, 'scripts/build-workspace-move-helper.mjs'),
    join(repository, 'apps/host/scripts/build.mjs'), join(repository, 'apps/host/scripts/build-workspace-move-helper.mjs'),
    ...await files(join(repository, 'apps/host/native')),
    join(repository, 'apps/host/package.json'), join(desktop, 'electron.vite.config.ts'),
    ...await files(join(desktop, 'src')), ...await files(join(repository, 'apps/host/src')),
    ...(await Promise.all(assets.map(name => files(join(desktop, name))))).flat(),
    ...await files(join(desktop, 'scripts')).then(paths => paths.filter(path => /(?:assets|aliases|update-identity|renderer-release)/u.test(path)))]
  for (const name of [...packages, 'layout']) {
    sourcePaths.push(join(repository, 'packages', name, 'package.json'), ...await files(join(repository, 'packages', name, 'src')))
  }
  const sourceFiles = await hashes([...new Set(sourcePaths)])
  const receipt = { schema: 'agentmux.capsule.native-build.v1', passed: false,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository, encoding: 'utf8' }).trim(),
    diffHash: sha(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: repository, maxBuffer: 32 * 1024 * 1024 })),
    sourceFiles, loadedSourceFiles: {}, compilerInputFiles: {}, dependencySourceFiles: {}, dependencyFiles: {}, compiledFiles: {},
    dependencyLayout: { nodeModules: relative(repository, await realpath(dependencyRoot)),
      assets: Object.fromEntries(await Promise.all(assets.map(async name => [name, relative(repository, await realpath(join(desktop, name)))]))) }, overlays: [] }
  const publish = () => writeFile(join(output, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await publish()
  const tsc = require.resolve('typescript/bin/tsc')
  // Topological workspace builds consume current source before Vite externalizes their artifacts.
  for (const name of packages) {
    const directory = join(repository, 'packages', name)
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (['identity', 'core'].includes(name)) await command(`${name} dependency`, process.execPath, [join(directory, 'scripts/build.mjs')])
    else {
      const config = ['capsule', 'git', 'demand', 'client-ui'].includes(name) ? 'tsconfig.build.json' : 'tsconfig.json'
      await command(`${name} dependency`, process.execPath, [tsc, '-p', config], directory)
    }
    assert.ok(pkg.scripts?.build, `Original workspace build contract: ${name}`)
    for (const path of await files(join(directory, 'src'))) {
      const key = relative(repository, path)
      assert.equal(sha(await readFile(path)), sourceFiles[key], `Dependency source changed during compilation: ${key}`)
      receipt.dependencySourceFiles[key] = sourceFiles[key]
    }
  }
  const host = join(repository, 'apps/host')
  await command('Host public modules', process.execPath, [join(host, 'scripts/build.mjs')])
  for (const path of await files(join(host, 'src'))) {
    const key = relative(repository, path)
    assert.equal(sha(await readFile(path)), sourceFiles[key], `Host source changed during compilation: ${key}`)
    receipt.dependencySourceFiles[key] = sourceFiles[key]
  }
  const { resolveConfig } = await import(require.resolve('electron-vite'))
  const { build } = await import(require.resolve('vite'))
  // electron-vite reads the App package type from cwd, just as its production CLI does.
  const originalDirectory = process.cwd()
  process.chdir(desktop)
  try {
    const entry = join(desktop, 'src/main/index.ts'), original = await readFile(entry, 'utf8')
    const anchor = 'const window = new BrowserWindow({\n      ...windowConstructorGeometry(persistedGeometry),'
    const placement = '    workbenchWindow = window'
    assert.equal(original.split(anchor).length, 2)
    assert.equal(original.split(placement).length, 2)
    const privateEntry = original.replace(anchor, anchor + '\n      show: false, focusable: false,').replace(placement,
      '    window.show = () => window.showInactive()\n    window.focus = () => {}\n    window.showInactive()\n' + placement)
    receipt.overlays.push({ file: relative(repository, entry), raw: sha(original), compilerInput: sha(privateEntry),
      scope: 'Nonactivating private BrowserWindow presentation only; original IPC, input, lifecycle and semantic owners are unchanged.' })
    const capture = () => ({ name: 'capsule-actual-product-input', enforce: 'pre', async load(id) {
      if (!id.startsWith(repository + '/') || id.includes('/node_modules/') || id.includes('?')) return null
      try {
        const bytes = await readFile(id), key = relative(repository, id)
        receipt.loadedSourceFiles[key] = sha(bytes)
        receipt.compilerInputFiles[key] = id === entry ? sha(privateEntry) : sha(bytes)
      } catch { return null }
      return id === entry ? privateEntry : null
    } })
    // Supply the observer before electron-vite captures each isolated-entry child config.
    const resolved = await resolveConfig({ root: desktop, configFile: join(desktop, 'electron.vite.config.ts'), plugins: [capture()] }, 'build', 'production')
    for (const name of ['main', 'preload', 'renderer']) {
      process.stdout.write(`capsule-build: actual ${name}\n`)
      const config = resolved.config[name]
      await build({ ...config, configFile: false,
        build: { ...config.build, outDir: join(output, name), emptyOutDir: true } })
    }
  } finally { process.chdir(originalDirectory) }
  for (const name of ['main', 'preload', 'renderer']) Object.assign(receipt.compiledFiles, await hashes(await files(join(output, name)), output))
  Object.assign(receipt.compiledFiles, await hashes([join(output, 'package.json')], output))
  const dependencyPaths = []
  for (const name of packages) dependencyPaths.push(join(repository, 'packages', name, 'package.json'), ...await files(join(repository, 'packages', name, 'dist')))
  dependencyPaths.push(join(host, 'package.json'), ...await files(join(host, 'dist')))
  receipt.dependencyFiles = await hashes(dependencyPaths)
  assert.deepEqual(await hashes([...new Set(sourcePaths)]), sourceFiles, 'Product source changed while building this candidate')
  for (const name of ['main/index.js', 'main/agentmux-host.js', 'preload/index.cjs', 'preload/capsule.cjs', 'renderer/index.html'])
    assert.ok(receipt.compiledFiles[name], `Nonempty production artifact: ${name}`)
  receipt.passed = true
  await publish()
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) process.stdout.write('Usage: node scripts/build-capsule-proof.mjs [output-directory]\n')
  else await buildCapsuleProof(process.argv[2])
}
