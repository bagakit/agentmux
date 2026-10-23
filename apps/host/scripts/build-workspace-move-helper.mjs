import { spawn } from 'node:child_process'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
/** Original confined no-replace protocol. Other platforms do not claim this optional operation. */
export async function buildWorkspaceMoveHelper() {
  if (process.platform !== 'darwin') return { supported: false }
  const hostRoot = resolve(import.meta.dirname, '..'), source = join(hostRoot, 'native', 'workspace-move.c')
  const outputDirectory = join(hostRoot, 'resources', 'bin'), output = join(outputDirectory, 'agentmux-workspace-move')
  const temporary = `${output}.${process.pid}.tmp`
  await mkdir(outputDirectory, { recursive: true }); await rm(temporary, { force: true })
  try {
    await new Promise((yes, no) => {
      const child = spawn('xcrun', ['clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', temporary], { cwd: hostRoot, stdio: 'inherit' })
      child.once('error', no); child.once('exit', (code, signal) => code === 0 ? yes() : no(new Error(`clang exited with ${signal ?? code}`)))
    })
    await chmod(temporary, 0o755); await rename(temporary, output)
    return { supported: true, output }
  } finally { await rm(temporary, { force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildWorkspaceMoveHelper()
