import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { runProbeProcess } from '../../../apps/desktop/scripts/probe-process.mjs'
import { supportedExamples, supportedExportMap } from './supported-entries.mjs'
import { stagePortableArchive } from './standalone/build.mjs'

const pkg = resolve(import.meta.dirname, '..')
const root = resolve(pkg, '../..')
const require = createRequire(import.meta.url)
const distribution = supportedExportMap('distribution')
const fixture = join(import.meta.dirname, 'standalone/fixture')
const evidence = join(root, '.tmp/client-ui-standalone-tarball', 'run-' + randomUUID())
await mkdir(evidence, { recursive: true })
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'client-ui-standalone-')))
const host = join(scratch, 'consumer')
const installed = join(host, 'node_modules/@agentmux/client-ui')
const staged = join(scratch, 'staged')
const digest = value => createHash('sha256').update(value).digest('hex')
const command = (executable, args, cwd) => spawnSync(executable, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 90_000 })
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'))
const writeJSON = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n')
const verify = (result, action) => {
  assert.ifError(result.error)
  assert.equal(result.status, 0, action + '\n' + result.stdout + result.stderr)
  return result.stdout
}
const allFiles = async directory => (await readdir(directory, { recursive: true, withFileTypes: true }))
  .filter(file => file.isFile()).map(file => relative(directory, join(file.parentPath, file.name))).sort()
const report = { candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), passed: false }

async function pack(directory, variant) {
  const output = join(scratch, 'archives', variant)
  await mkdir(output, { recursive: true })
  const [archive] = JSON.parse(verify(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], directory), 'Pack local archive ' + variant))
  const file = join(output, archive.filename)
  const actual = join(output, 'extracted')
  await mkdir(actual)
  verify(command('tar', ['-xzf', file, '--strip-components=1', '-C', actual], output), 'Read actual npm archive')
  const paths = await allFiles(actual)
  assert.deepEqual(paths, archive.files.map(item => item.path).sort())
  return { file, actual, paths, sha256: digest(await readFile(file)), integrity: archive.integrity }
}

async function inspect(archive, expectedPaths) {
  const manifest = await readJSON(join(archive.actual, 'package.json'))
  assert.equal(manifest.private, true)
  assert.ok(!Object.hasOwn(manifest, 'license'), 'A qualification archive must preserve the pending project license decision')
  const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies }
  assert.ok(!Object.entries(dependencies).some(([name, version]) => name.startsWith('@agentmux/') ||
    /^(?:workspace|file|link):/u.test(version)), 'Private npm dependency in the archive')
  assert.deepEqual(manifest.exports, distribution, 'Portable exports include a private or source-dependent target')
  for (const path of archive.paths) {
    assert.ok(expectedPaths.includes(path), 'Unexpected archive input ' + path)
    const text = await readFile(join(archive.actual, path), 'utf8')
    for (const absolute of [root, scratch, homedir()]) assert.ok(!text.includes(absolute), 'Archive contains a machine path in ' + path)
    if (!path.endsWith('.md')) continue
    for (const [, target] of text.matchAll(/\]\(([^)]+)\)/gu)) {
      if (/^(?:https?:|#)/u.test(target)) continue
      const file = relative(archive.actual, resolve(archive.actual, dirname(path), target.split('#')[0]))
      assert.ok(archive.paths.includes(file), 'Packaged documentation references a missing file ' + file)
    }
  }
  assert.ok(archive.paths.every(path => /^(?:dist\/.*\.(?:js|ts|css)|examples\/[^/]+\.(?:tsx|css)|docs\/patterns\/agent-work-location\.md|(?:THIRD_PARTY_NOTICES|README)\.md|(?:package|PROVENANCE)\.json)$/u.test(path)), 'A disallowed source or asset entered the archive')
  const provenance = await readJSON(join(archive.actual, 'PROVENANCE.json'))
  const notices = await readFile(join(archive.actual, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  for (const dependency of provenance.bundled) assert.ok(notices.includes('## ' + dependency.id), 'Missing bundled copyright for ' + dependency.id)
  for (const name of ['@radix-ui/react-dismissable-layer', '@radix-ui/react-focus-scope', 'react-remove-scroll-bar', 'lucide-react']) {
    assert.ok(provenance.bundled.some(dependency => dependency.id.startsWith(name + '@')), 'Missing distribution attribution ' + name)
  }
  return manifest
}

async function installHost(archive) {
  await mkdir(host)
  await cp(fixture, host, { recursive: true })
  const versions = Object.fromEntries(['react', 'react-dom', 'typescript', '@types/react', '@types/react-dom'].map(name =>
    [name, require(name + '/package.json').version]))
  const vite = createRequire(require.resolve('vitest'))('vite/package.json')
  await writeJSON(join(host, 'package.json'), { private: true, type: 'module', dependencies: { ...versions, vite: vite.version,
    '@agentmux/client-ui': 'file:' + archive.file } })
  verify(command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], host), 'Install from the actual archive outside the workspace')
  const lock = await readJSON(join(host, 'package-lock.json'))
  const fromPack = lock.packages['node_modules/@agentmux/client-ui']
  assert.equal(fromPack.integrity, archive.integrity)
  assert.ok(Object.entries(lock.packages).every(([path, item]) => !item.link && (path === 'node_modules/@agentmux/client-ui' ||
    !item.resolved || item.resolved.startsWith('https:'))), 'Standalone app resolved a shared or linked dependency')
  assert.ok(Object.keys(lock.packages).every(path => !path.includes('/@agentmux/') || path === 'node_modules/@agentmux/client-ui'))
  for (const file of Object.keys(versions)) assert.ok((await realpath(join(host, 'node_modules', file))).startsWith(host + '/node_modules/'))
  await cp(join(installed, 'examples'), join(host, 'examples'), { recursive: true })
  await writeFile(join(host, 'examples.ts'), [
    "import '@agentmux/client-ui/styles/theme-defaults.css'",
    ...Object.keys(supportedExamples).map(name => `export { default as ${name} } from './examples/${name}'`)
  ].join('\n') + '\n')
  await writeFile(join(host, 'styles.d.ts'), "declare module '*.css?inline' { const styles: string; export default styles }\n")
  await writeJSON(join(host, 'tsconfig.json'), { compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext',
    moduleResolution: 'Bundler', jsx: 'react-jsx', types: ['vite/client'], exactOptionalPropertyTypes: true, noUncheckedSideEffectImports: true },
  include: ['host.tsx', 'locations.tsx', 'examples.ts', 'styles.d.ts'] })
  await writeFile(join(host, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Independent board</title><div id="app"></div><script type="module" src="./host.tsx"></script>\n')
  return { npmDependencies: Object.keys(lock.packages).length - 1, versions: { ...versions, vite: vite.version }, integrity: fromPack.integrity }
}

async function installVariant(archive) {
  // Keep the independently installed published dependencies. Replace only our own package with this real archive.
  assert.equal(await realpath(installed), installed)
  await rm(installed, { recursive: true })
  await mkdir(installed)
  verify(command('tar', ['-xzf', archive.file, '--strip-components=1', '-C', installed], host), 'Install a private test variant')
}

async function verifyInstalled(archive) {
  assert.deepEqual(await allFiles(installed), archive.paths)
  for (const path of archive.paths) {
    const file = join(installed, path)
    assert.equal(await realpath(file), file, 'Installed package file must be local to the independent app')
    assert.equal(digest(await readFile(file)), digest(await readFile(join(archive.actual, path))), 'Installed bytes differ from the verified npm archive')
  }
}

const typecheck = () => command(process.execPath, ['node_modules/typescript/bin/tsc', '--pretty', 'false'], host)
const buildHost = (variant, output) => command(process.execPath, ['build-host.mjs', variant, output], host)
const rejected = (result, expected) => {
  assert.ifError(result.error)
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, expected)
}

async function browser(variant, output, mode = 'normal') {
  await mkdir(output, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(join(root, 'apps/desktop/package.json'))('electron')
  const result = await runProbeProcess(electron, [join(host, 'browser.cjs'), join(host, 'browser', variant, 'index.html'), output, mode, join(host, 'profiles', variant)],
    { cwd: host, env, timeoutMs: 50_000, temporaryRoot: output })
  assert.equal(result.exitConfirmed, true)
  const observed = await readJSON(join(output, 'browser.json'))
  assert.equal(result.exitCode, observed.passed ? 0 : 1)
  return observed
}

async function mutation(name, alter) {
  const directory = join(scratch, 'variant', name)
  await cp(staged, directory, { recursive: true })
  await alter(directory)
  return pack(directory, name)
}

try {
  const inputs = [
    'package.json', 'README.md', 'scripts/supported-entries.mjs', 'scripts/radix-overlay-aliases.ts',
    'scripts/verify-standalone-tarball.mjs', ...(await allFiles(join(import.meta.dirname, 'standalone'))).map(file => 'scripts/standalone/' + file)
  ]
  report.sourceHashes = Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(pkg, file)))])))
  const { overlay, provenance } = await stagePortableArchive(staged)
  const originalPaths = await allFiles(staged)
  const normal = await pack(staged, 'normal')
  await inspect(normal, originalPaths)
  assert.deepEqual(normal.paths, originalPaths, 'Stage and npm archive contain different files')
  report.archive = { sha256: normal.sha256, integrity: normal.integrity, paths: normal.paths, overlay,
    bundled: provenance.bundled.map(value => value.id), patches: provenance.patches }
  report.installed = await installHost(normal)
  await verifyInstalled(normal)
  report.node = JSON.parse(verify(command(process.execPath, ['node.mjs'], host), 'Load all Node entries from the installed archive'))
  verify(typecheck(), 'Compile the examples and host against installed declarations')
  verify(buildHost('normal', evidence), 'Build the host and official examples against the installed package')
  report.browserInputs = await readJSON(join(evidence, 'browser-inputs.json'))
  for (const target of Object.values(distribution)) {
    assert.ok(report.browserInputs.includes((typeof target === 'string' ? target : target.import).slice(2)), 'The standalone browser graph missed an installed entry')
  }
  report.browser = await browser('normal', evidence)
  assert.equal(report.browser.passed, true, report.browser.failure)
  report.mutations = {}

  const noTypes = await mutation('missing-declaration', directory => unlink(join(directory, distribution['./components/Button'].types)))
  await inspect(noTypes, originalPaths)
  await installVariant(noTypes)
  await verifyInstalled(noTypes)
  rejected(typecheck(), /(?:TS7016|TS2307):[^\n]*@agentmux\/client-ui\/components\/Button/u)
  report.mutations.declarations = { sha256: noTypes.sha256, rejectedBy: 'installed TypeScript consumer' }
  const noCss = await mutation('missing-css', directory => unlink(join(directory, distribution['./styles/buttons.css'])))
  await inspect(noCss, originalPaths)
  await installVariant(noCss)
  await verifyInstalled(noCss)
  rejected(buildHost('missing-css', evidence), /buttons\.css/u)
  report.mutations.styles = { sha256: noCss.sha256, rejectedBy: 'installed Vite consumer' }

  const privateDependency = await mutation('private-package', async directory => {
    const file = join(directory, 'package.json'), value = await readJSON(file)
    value.dependencies['@agentmux/core'] = 'workspace:*'
    await writeJSON(file, value)
  })
  await assert.rejects(inspect(privateDependency, originalPaths), /Private npm dependency/u)
  report.mutations.privateDependency = { sha256: privateDependency.sha256, rejectedBy: 'archive manifest' }
  const coreFile = 'packages/core/src/object-id.ts'
  const embeddedCore = await mutation('embedded-core', directory => copyFile(join(root, coreFile), join(directory, 'dist/core-object-id.js')))
  await assert.rejects(inspect(embeddedCore, originalPaths), /Unexpected archive input dist\/core-object-id\.js/u)
  report.mutations.embeddedCore = { sha256: embeddedCore.sha256, sourceSha256: digest(await readFile(join(root, coreFile))), rejectedBy: 'archive inventory' }
  const sourceResolution = await mutation('source-fallback', async directory => {
    const file = join(directory, 'package.json'), value = await readJSON(file)
    const browser = './src/components/Button.tsx'
    const { types, import: compiled } = value.exports['./components/Button']
    value.exports['./components/Button'] = { types, browser, import: compiled }
    value.files.push('src')
    const target = join(directory, browser)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(pkg, browser), target)
    await writeJSON(file, value)
  })
  await assert.rejects(inspect(sourceResolution, originalPaths), /source-dependent target/u)
  await installVariant(sourceResolution)
  await verifyInstalled(sourceResolution)
  rejected(buildHost('source-fallback', evidence), /Browser resolved private or source inputs/u)
  report.mutations.sourceFallback = { sha256: sourceResolution.sha256, rejectedBy: 'archive exports and installed Vite consumer' }

  await installVariant(normal)
  const locationSource = join(host, 'locations.tsx')
  const persisted = await readFile(locationSource, 'utf8'), choice = 'const route = choice.route'
  assert.equal(persisted.split(choice).length, 2)
  const changed = persisted.replace(choice, "const route = 'brief'")
  await writeFile(locationSource, changed)
  verify(buildHost('wrong-location', evidence), 'Build the actual altered location consumer')
  const wrongLocation = await browser('wrong-location', join(evidence, 'wrong-location'), 'locations')
  assert.equal(wrongLocation.passed, false)
  assert.match(wrongLocation.failure, /Open the exact selected work route.*Mira\/review\/brief/u)
  report.mutations.location = { sourceSha256: digest(changed), result: wrongLocation }
  await writeFile(locationSource, persisted)

  const wrongScrollStage = join(scratch, 'scroll-stage')
  const scroll = await stagePortableArchive(wrongScrollStage, { mutateScroll: true })
  const wrongScroll = await pack(wrongScrollStage, 'wrong-scroll')
  await installVariant(wrongScroll)
  await verifyInstalled(wrongScroll)
  verify(buildHost('wrong-scroll', evidence), 'Build a host consuming the isolated archived scroll-lock fault')
  const wrongDocument = await browser('wrong-scroll', join(evidence, 'wrong-scroll'), 'scroll')
  assert.equal(wrongDocument.passed, false)
  assert.match(wrongDocument.failure, /The second scroll lock belongs to its original Document/u)
  report.mutations.scroll = { sha256: wrongScroll.sha256, source: scroll.scrollMutation, result: wrongDocument }

  await installVariant(normal)
  await verifyInstalled(normal)
  verify(typecheck(), 'Restore the exact originally qualified package and external adapter')
  await writeJSON(join(evidence, 'browser-inputs.json'), report.browserInputs)
  await copyFile(normal.file, join(evidence, 'private-client-ui.tgz'))
  report.restored = true
  report.passed = true
} finally {
  await rm(scratch, { recursive: true })
  await assert.rejects(stat(scratch), { code: 'ENOENT' })
  report.externalHostRemoved = true
  await writeJSON(join(evidence, 'receipt.json'), report)
}
console.log(JSON.stringify({ passed: report.passed, receipt: relative(root, join(evidence, 'receipt.json')) }))
