import { spawn } from 'node:child_process'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

const desktopRoot = resolve(import.meta.dirname, '..')
const source = join(desktopRoot, 'native', 'workspace-move.c')
const outputDirectory = join(desktopRoot, 'resources', 'bin')
const output = join(outputDirectory, 'agentmux-workspace-move')
const temporary = `${output}.${process.pid}.tmp`
const compiler = 'xcrun'
const args = ['clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', temporary]

if (process.platform !== 'darwin') {
  throw new Error(`Atomic confined no-replace Workspace move is unavailable on ${process.platform}`)
}

await mkdir(outputDirectory, { recursive: true })
await rm(temporary, { force: true })
try {
  await new Promise((resolveBuild, reject) => {
    const child = spawn(compiler, args, { cwd: desktopRoot, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveBuild()
      else reject(new Error(`${compiler} exited with ${signal ?? code}`))
    })
  })
  await chmod(temporary, 0o755)
  await rename(temporary, output)
} finally {
  await rm(temporary, { force: true })
}
