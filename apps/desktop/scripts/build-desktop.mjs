import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareElectronApplication } from './electron-application.mjs'
import { copyMobile } from './copy-mobile.mjs'
import { writeRendererRelease } from './build-renderer-release.mjs'

async function run(command, args, cwd) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`${command} exited with ${signal ?? code}`)))
  })
}

/** pnpm owns the existing prebuild hook; this flow publishes only its completed payload. */
export async function buildDesktop(root) {
  const desktop = join(root, 'apps/desktop')
  await prepareElectronApplication(root)
  await run('pnpm', ['--filter', '@agentmux/mobile', 'build'], desktop)
  await run('electron-vite', ['build'], desktop)
  await copyMobile(root)
  await writeRendererRelease(root)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildDesktop(resolve(import.meta.dirname, '../../..'))
}
