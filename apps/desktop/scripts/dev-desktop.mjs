import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(import.meta.dirname, '..')
const electronRoot = dirname(require.resolve('electron'))
const electronRelativePath = (await readFile(join(electronRoot, 'path.txt'), 'utf8')).trim()
const electronExecutable = join(electronRoot, 'dist', electronRelativePath)
const electronApp = resolve(electronExecutable, '../../..')
const brandedRoot = join(desktopRoot, 'node_modules', '.cache', 'agentmux-electron')
const developmentUserData = join(desktopRoot, 'node_modules', '.cache', 'agentmux-user-data')
const brandedApp = join(brandedRoot, 'AgentMux.app')
const brandedExecutable = join(brandedApp, 'Contents', 'MacOS', 'AgentMux')
const sourceVersion = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8')).version
const stampPath = join(brandedRoot, 'version.txt')

async function run(command, args, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with ${signal ?? code}`))
    })
  })
}

async function prepareMacApp() {
  const expectedStamp = `AgentMux\n${sourceVersion}\n`
  try {
    if (await readFile(stampPath, 'utf8') === expectedStamp) return brandedExecutable
  } catch {
    // A missing or stale cache is rebuilt from the installed Electron artifact.
  }

  const nextRoot = `${brandedRoot}.${process.pid}.tmp`
  await rm(nextRoot, { recursive: true, force: true })
  await mkdir(nextRoot, { recursive: true })
  const nextApp = join(nextRoot, 'AgentMux.app')
  await run('cp', ['-cR', electronApp, nextApp])

  const contents = join(nextApp, 'Contents')
  const plist = join(contents, 'Info.plist')
  await run('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'AgentMux', plist])
  await run('plutil', ['-replace', 'CFBundleName', '-string', 'AgentMux', plist])
  await run('plutil', ['-replace', 'CFBundleIdentifier', '-string', 'dev.agentmux.desktop', plist])
  await run('plutil', ['-replace', 'CFBundleExecutable', '-string', 'AgentMux', plist])
  await run('plutil', ['-replace', 'CFBundleIconFile', '-string', 'agentmux.icns', plist])
  await rename(join(contents, 'MacOS', 'Electron'), join(contents, 'MacOS', 'AgentMux'))
  await copyFile(join(desktopRoot, 'resources', 'icon.icns'), join(contents, 'Resources', 'agentmux.icns'))
  await run('codesign', ['--force', '--deep', '--sign', '-', nextApp])
  await rm(brandedRoot, { recursive: true, force: true })
  await rename(nextRoot, brandedRoot)
  await writeFile(stampPath, expectedStamp)
  return brandedExecutable
}

const executable = process.platform === 'darwin' ? await prepareMacApp() : electronExecutable
if (process.argv.includes('--prepare-only')) {
  process.stdout.write(`${executable}\n`)
  process.exit(0)
}

const electronVite = join(desktopRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite')
const child = spawn(electronVite, ['dev'], {
  cwd: desktopRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    AGENTMUX_DESKTOP_USER_DATA: developmentUserData,
    ELECTRON_EXEC_PATH: executable
  }
})
child.once('error', (error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
