import { spawn } from 'node:child_process'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

const PRODUCT_NAME = 'AgentMux'
const BUNDLE_ID = 'dev.agentmux.desktop'
const CTXMUX_RUNTIME_ID = '88e8377ecc4341b655d47306'
const require = createRequire(import.meta.url)
const desktopRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const manifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))
const coreRoot = join(repositoryRoot, 'packages', 'core')
const releaseRoot = join(desktopRoot, 'release', 'mac')
const outputApp = join(releaseRoot, `${PRODUCT_NAME}.app`)
const outputDmg = join(
  releaseRoot,
  `${PRODUCT_NAME}-${manifest.version}-${process.platform}-${process.arch}.dmg`
)
const installRequested = process.argv.includes('--install')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function run(command, args, options = {}) {
  const capture = options.capture ?? false
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: capture ? [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] : 'inherit'
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      if (options.input !== undefined) child.stdin.end(options.input)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
    }
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error(`${command} exited with ${signal ?? code}${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

async function pathExists(path) {
  return await lstat(path).then(() => true, () => false)
}

async function plistReplace(path, key, type, value) {
  await run('plutil', ['-replace', key, `-${type}`, String(value), path], { capture: true })
}

async function plistRemove(path, key) {
  await run('plutil', ['-remove', key, path], { capture: true })
}

async function plistValue(path, key) {
  return (await run('plutil', ['-extract', key, 'raw', '-o', '-', path], { capture: true })).stdout.trim()
}

async function brandApplication(appPath) {
  const contents = join(appPath, 'Contents')
  const plist = join(contents, 'Info.plist')
  const resources = join(contents, 'Resources')
  const executable = join(contents, 'MacOS', PRODUCT_NAME)
  await rename(join(contents, 'MacOS', 'Electron'), executable)
  await plistReplace(plist, 'CFBundleDisplayName', 'string', PRODUCT_NAME)
  await plistReplace(plist, 'CFBundleName', 'string', PRODUCT_NAME)
  await plistReplace(plist, 'CFBundleIdentifier', 'string', BUNDLE_ID)
  await plistReplace(plist, 'CFBundleExecutable', 'string', PRODUCT_NAME)
  await plistReplace(plist, 'CFBundleIconFile', 'string', 'agentmux.icns')
  await plistReplace(plist, 'CFBundleShortVersionString', 'string', manifest.version)
  await plistReplace(plist, 'CFBundleVersion', 'string', manifest.version)
  await plistReplace(plist, 'LSApplicationCategoryType', 'string', 'public.app-category.developer-tools')
  for (const key of [
    'NSAppTransportSecurity',
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription'
  ]) await plistRemove(plist, key)

  const helpers = [
    { suffix: '', idSuffix: '' },
    { suffix: ' (Renderer)', idSuffix: '.renderer' },
    { suffix: ' (GPU)', idSuffix: '.gpu' },
    { suffix: ' (Plugin)', idSuffix: '.plugin' }
  ]
  const frameworks = join(contents, 'Frameworks')
  for (const helper of helpers) {
    const sourceName = `Electron Helper${helper.suffix}`
    const targetName = `${PRODUCT_NAME} Helper${helper.suffix}`
    const targetApp = join(frameworks, `${targetName}.app`)
    await rename(join(frameworks, `${sourceName}.app`), targetApp)
    await rename(
      join(targetApp, 'Contents', 'MacOS', sourceName),
      join(targetApp, 'Contents', 'MacOS', targetName)
    )
    const helperPlist = join(targetApp, 'Contents', 'Info.plist')
    await plistReplace(helperPlist, 'CFBundleDisplayName', 'string', targetName)
    await plistReplace(helperPlist, 'CFBundleName', 'string', targetName)
    await plistReplace(helperPlist, 'CFBundleExecutable', 'string', targetName)
    await plistReplace(helperPlist, 'CFBundleIdentifier', 'string', `${BUNDLE_ID}.helper${helper.idSuffix}`)
  }

  await cp(join(desktopRoot, 'resources', 'icon.icns'), join(resources, 'agentmux.icns'))
  await rm(join(resources, 'electron.icns'), { force: true })
  await rm(join(resources, 'default_app.asar'), { force: true })
}

async function copyRuntimeApplication(appPath) {
  const resources = join(appPath, 'Contents', 'Resources')
  const appResources = join(resources, 'app')
  await mkdir(join(appResources, 'node_modules', '@agentmux'), { recursive: true })
  await cp(join(desktopRoot, 'out'), join(appResources, 'out'), { recursive: true })
  await cp(join(desktopRoot, 'resources'), join(appResources, 'resources'), { recursive: true })
  await writeFile(join(appResources, 'package.json'), `${JSON.stringify({
    name: 'agentmux-desktop',
    productName: PRODUCT_NAME,
    version: manifest.version,
    private: true,
    type: 'module',
    main: 'out/main/index.js'
  }, null, 2)}\n`)

  const coreRuntime = join(appResources, 'node_modules', '@agentmux', 'core')
  await mkdir(coreRuntime, { recursive: true })
  await cp(join(coreRoot, 'dist'), join(coreRuntime, 'dist'), { recursive: true })
  await cp(join(coreRoot, 'vendor'), join(coreRuntime, 'vendor'), { recursive: true })
  await cp(join(coreRoot, 'bin'), join(coreRuntime, 'bin'), { recursive: true })
  const coreManifest = JSON.parse(await readFile(join(coreRoot, 'package.json'), 'utf8'))
  await writeFile(join(coreRuntime, 'package.json'), `${JSON.stringify({
    name: coreManifest.name,
    version: coreManifest.version,
    type: coreManifest.type,
    main: coreManifest.main,
    exports: coreManifest.exports,
    engines: coreManifest.engines,
    os: coreManifest.os,
    cpu: coreManifest.cpu,
    bin: coreManifest.bin
  }, null, 2)}\n`)
  await materializeDependencies(
    coreRoot,
    coreManifest.dependencies ?? {},
    join(coreRuntime, 'node_modules')
  )
  await materializeDependency(desktopRoot, 'zod', join(appResources, 'node_modules', 'zod'))
  await Promise.all([
    chmod(join(coreRuntime, 'vendor', 'ctxmux', 'darwin-arm64', 'bin', 'ctxmux'), 0o755),
    chmod(join(coreRuntime, 'vendor', 'ctxmux', 'darwin-arm64', 'bin', 'ctxmuxd'), 0o755),
    chmod(join(coreRuntime, 'bin', 'agentmux.js'), 0o755)
  ])
}

async function materializeDependencies(sourcePackage, dependencies, destination) {
  for (const packageName of Object.keys(dependencies).sort()) {
    await materializeDependency(
      sourcePackage,
      packageName,
      join(destination, ...packageName.split('/'))
    )
  }
}

async function materializeDependency(sourcePackage, packageName, destination) {
  const source = await resolvePackageRoot(sourcePackage, packageName)
  const packageManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    await cp(join(source, entry.name), join(destination, entry.name), {
      recursive: entry.isDirectory()
    })
  }
  await materializeDependencies(
    source,
    packageManifest.dependencies ?? {},
    join(destination, 'node_modules')
  )
}

async function resolvePackageRoot(sourcePackage, packageName) {
  let current = sourcePackage
  while (true) {
    const candidate = join(current, 'node_modules', ...packageName.split('/'))
    if (await pathExists(candidate)) return await realpath(candidate)
    if (current === repositoryRoot) break
    const parent = dirname(current)
    if (parent === current || relative(repositoryRoot, parent).startsWith(`..${sep}`)) break
    current = parent
  }
  throw new Error(`Could not resolve package root for ${packageName} from ${sourcePackage}.`)
}

async function auditBundleSymlinks(root) {
  const canonicalRoot = await realpath(root)
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await readlink(path)
        assert(!target.startsWith('/'), `Bundle contains an absolute symlink: ${path} -> ${target}`)
        const canonicalTarget = await realpath(path)
        const offset = relative(canonicalRoot, canonicalTarget)
        assert(offset !== '..' && !offset.startsWith(`..${sep}`), `Bundle symlink escapes the application: ${path}`)
      } else if (entry.isDirectory()) await visit(path)
    }
  }
  await visit(root)
}

async function auditRuntimeReferences(appPath, temporaryRoot) {
  const forbidden = [repositoryRoot, temporaryRoot]
  const runtimeRoot = join(appPath, 'Contents', 'Resources', 'app')
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!entry.isFile() || (await stat(path)).size > 2 * 1024 * 1024) continue
      const content = await readFile(path)
      if (content.includes(0)) continue
      const text = content.toString('utf8')
      for (const reference of forbidden) {
        assert(!text.includes(reference), `Packaged runtime contains a build-machine path in ${path}.`)
      }
    }
  }
  await visit(runtimeRoot)
}

async function verifyIdentity(appPath) {
  const contents = join(appPath, 'Contents')
  const plist = join(contents, 'Info.plist')
  assert(await plistValue(plist, 'CFBundleDisplayName') === PRODUCT_NAME, 'Packaged display name is wrong.')
  assert(await plistValue(plist, 'CFBundleExecutable') === PRODUCT_NAME, 'Packaged executable name is wrong.')
  assert(await plistValue(plist, 'CFBundleIdentifier') === BUNDLE_ID, 'Packaged bundle id is wrong.')
  assert(await plistValue(plist, 'CFBundleIconFile') === 'agentmux.icns', 'Packaged icon is wrong.')
  assert(!await pathExists(join(contents, 'Resources', 'default_app.asar')), 'Electron default app entered the package.')
  for (const suffix of ['', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
    assert(
      await pathExists(join(contents, 'Frameworks', `${PRODUCT_NAME} Helper${suffix}.app`)),
      `Packaged helper is missing: ${PRODUCT_NAME} Helper${suffix}.app`
    )
    assert(
      !await pathExists(join(contents, 'Frameworks', `Electron Helper${suffix}.app`)),
      `Unbranded Electron Helper remains: ${suffix || 'main'}`
    )
  }
}

async function verifyPackagedRuntime(appPath, verificationRoot) {
  const appResources = join(appPath, 'Contents', 'Resources', 'app')
  const coreRuntime = join(appResources, 'node_modules', '@agentmux', 'core')
  const binaryRoot = join(coreRuntime, 'vendor', 'ctxmux', 'darwin-arm64', 'bin')
  const [cli, daemon] = await Promise.all([
    run(join(binaryRoot, 'ctxmux'), ['--version'], { capture: true }),
    run(join(binaryRoot, 'ctxmuxd'), ['--version'], { capture: true })
  ])
  assert(cli.stdout.trim() === 'ctxmux 0.1.0 (protocol 9)', 'Packaged ctxmux identity is wrong.')
  assert(daemon.stdout.trim() === 'ctxmuxd 0.1.0 (protocol 9)', 'Packaged ctxmuxd identity is wrong.')
  const manifest = JSON.parse(await readFile(
    join(coreRuntime, 'vendor', 'ctxmux', 'darwin-arm64', 'manifest.json'),
    'utf8'
  ))
  assert(
    manifest.source.commit === '3b94288c3a7896bb355e028135409c8e8bbaf764',
    'Packaged ctxmux manifest commit is wrong.'
  )
}

async function processIdsForApplication(appPath) {
  const executable = join(appPath, 'Contents', 'MacOS', PRODUCT_NAME)
  const helperRoot = join(appPath, 'Contents', 'Frameworks') + sep
  const result = await run('ps', ['-axo', 'pid=,command='], { capture: true })
  return result.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match || (match[2] !== executable && !match[2].startsWith(helperRoot))) return []
    return [Number(match[1])]
  })
}

async function verifyLaunchServices(appPath, verificationRoot) {
  const readyFile = join(verificationRoot, 'desktop-ready.json')
  const userData = join(verificationRoot, 'user-data')
  const processTemporaryDirectory = await mkdtemp(join(tmpdir(), 'amx-smoke-'))
  const stdoutPath = join(verificationRoot, 'desktop-stdout.log')
  const stderrPath = join(verificationRoot, 'desktop-stderr.log')
  const endpointPath = join(
    processTemporaryDirectory,
    `amx-${process.getuid()}-${CTXMUX_RUNTIME_ID}`,
    'ctxmux.sock'
  )
  const executable = join(appPath, 'Contents', 'MacOS', PRODUCT_NAME)
  const daemonEntrypoint = join(
    appPath,
    'Contents',
    'Resources',
    'app',
    'node_modules',
    '@agentmux',
    'core',
    'vendor',
    'ctxmux',
    'darwin-arm64',
    'bin',
    'ctxmuxd'
  )
  await mkdir(userData, { recursive: true })
  const before = new Set(await processIdsForApplication(appPath))
  try {
    await run('open', [
      '-n',
      '-j',
      '-W',
      '-a', appPath,
      '--stdout', stdoutPath,
      '--stderr', stderrPath,
      '--env', `AGENTMUX_DESKTOP_USER_DATA=${userData}`,
      '--env', `AGENTMUX_DESKTOP_READY_FILE=${readyFile}`,
      '--env', 'AGENTMUX_DESKTOP_EXIT_AFTER_READY=1',
      '--env', `TMPDIR=${processTemporaryDirectory}`
    ], { capture: true })
    if (!await pathExists(readyFile)) {
      const stderr = await readFile(stderrPath, 'utf8').catch(() => '')
      throw new Error(`Packaged Desktop did not emit a ready receipt${stderr ? `: ${stderr.trim()}` : '.'}`)
    }
    const ready = JSON.parse(await readFile(readyFile, 'utf8'))
    assert(ready.productName === PRODUCT_NAME, 'LaunchServices started an incorrectly branded application.')
    assert(ready.packaged === true, 'LaunchServices did not start the packaged application.')
    const remaining = (await processIdsForApplication(appPath)).filter((pid) => !before.has(pid))
    assert(remaining.length === 0, `Packaged Desktop left ${remaining.length} process(es) after the smoke run.`)
  } finally {
    try {
      const processes = await run('ps', ['-axo', 'pid=,command='], { capture: true })
      for (const line of processes.stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
        if (!match || !match[2].includes(daemonEntrypoint) || !match[2].includes(endpointPath)) continue
        process.kill(Number(match[1]), 'SIGTERM')
      }
      const deadline = Date.now() + 5_000
      while (await pathExists(endpointPath) && Date.now() <= deadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
      }
      assert(!await pathExists(endpointPath), 'Launch smoke ctxmuxd endpoint survived scoped cleanup.')
    } finally {
      await rm(processTemporaryDirectory, { recursive: true, force: true })
    }
  }
}

async function createDmg(appPath, temporaryRoot) {
  const dmgRoot = join(temporaryRoot, 'dmg-root')
  await mkdir(dmgRoot)
  await run('cp', ['-cR', appPath, join(dmgRoot, basename(appPath))], { capture: true })
  await symlink('/Applications', join(dmgRoot, 'Applications'))
  await run('hdiutil', [
    'create',
    '-volname', PRODUCT_NAME,
    '-srcfolder', dmgRoot,
    '-format', 'UDZO',
    '-ov',
    outputDmg
  ], { capture: true })
  await detachCreatedImage(outputDmg)
  await run('hdiutil', ['verify', outputDmg], { capture: true })
}

async function detachCreatedImage(imagePath) {
  const info = await run('hdiutil', ['info', '-plist'], { capture: true })
  const json = await run('plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
    capture: true,
    input: info.stdout
  })
  const images = JSON.parse(json.stdout).images ?? []
  const canonicalImagePath = await realpath(imagePath)
  for (const image of images) {
    if (!image['image-path'] || await realpath(image['image-path']) !== canonicalImagePath) continue
    const device = image['system-entities']
      ?.find((entity) => typeof entity['dev-entry'] === 'string')?.['dev-entry']
    assert(device, `Created DMG is busy without an owned device: ${imagePath}`)
    await run('hdiutil', ['detach', device], { capture: true })
  }
}

async function verifyDmg(temporaryRoot) {
  const mountPoint = join(temporaryRoot, 'mounted-dmg')
  const verificationRoot = join(temporaryRoot, 'verification')
  const applicationsRoot = join(verificationRoot, 'Applications')
  const installedApp = join(applicationsRoot, `${PRODUCT_NAME}.app`)
  await mkdir(mountPoint)
  await mkdir(applicationsRoot, { recursive: true })
  await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, outputDmg], { capture: true })
  try {
    const entries = (await readdir(mountPoint)).sort()
    assert(entries.includes(`${PRODUCT_NAME}.app`), 'DMG does not contain AgentMux.app.')
    assert(entries.includes('Applications'), 'DMG does not contain the Applications link.')
    await run('ditto', [join(mountPoint, `${PRODUCT_NAME}.app`), installedApp], { capture: true })
  } finally {
    await run('hdiutil', ['detach', mountPoint], { capture: true })
  }
  await verifyIdentity(installedApp)
  await auditBundleSymlinks(installedApp)
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', installedApp], { capture: true })
  await verifyPackagedRuntime(installedApp, verificationRoot)
  await verifyLaunchServices(installedApp, verificationRoot)
}

async function installApplication(appPath) {
  const applicationsRoot = join(homedir(), 'Applications')
  const destination = join(applicationsRoot, `${PRODUCT_NAME}.app`)
  const next = join(applicationsRoot, `.${PRODUCT_NAME}.install-${process.pid}.app`)
  await mkdir(applicationsRoot, { recursive: true })
  await rm(next, { recursive: true, force: true })
  await run('ditto', [appPath, next], { capture: true })
  await run('codesign', ['--verify', '--deep', '--strict', next], { capture: true })
  await rm(destination, { recursive: true, force: true })
  await rename(next, destination)
  process.stdout.write(`installed_app=${destination}\n`)
}

async function main() {
  assert(process.platform === 'darwin', 'macOS packaging must run on macOS.')
  assert(process.arch === 'arm64' || process.arch === 'x64', `Unsupported macOS architecture: ${process.arch}`)
  const electronRoot = dirname(require.resolve('electron/package.json'))
  const electronApp = join(electronRoot, 'dist', 'Electron.app')
  assert(await pathExists(electronApp), 'The locked Electron application is missing.')
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agentmux-macos-package-'))
  try {
    const stagedApp = join(temporaryRoot, `${PRODUCT_NAME}.app`)
    await run('cp', ['-cR', electronApp, stagedApp], { capture: true })
    await brandApplication(stagedApp)
    await copyRuntimeApplication(stagedApp)
    await verifyIdentity(stagedApp)
    await auditBundleSymlinks(stagedApp)
    await auditRuntimeReferences(stagedApp, temporaryRoot)
    await run('codesign', ['--force', '--deep', '--sign', '-', stagedApp], { capture: true })
    await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', stagedApp], { capture: true })

    await rm(releaseRoot, { recursive: true, force: true })
    await mkdir(releaseRoot, { recursive: true })
    await rename(stagedApp, outputApp)
    await createDmg(outputApp, temporaryRoot)
    await verifyDmg(temporaryRoot)
    if (installRequested) await installApplication(outputApp)
    const appSize = (await run('du', ['-sk', outputApp], { capture: true })).stdout.trim().split(/\s+/)[0]
    const dmgSize = (await stat(outputDmg)).size
    process.stdout.write([
      `app=${outputApp}`,
      `dmg=${outputDmg}`,
      'signature=adhoc-local-candidate',
      `app_size_kib=${appSize}`,
      `dmg_size_bytes=${dmgSize}`,
      'notarized=false'
    ].join('\n') + '\n')
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main()
