import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const entry = await lstat(path)
  if (!entry.isDirectory() || (process.getuid && entry.uid !== process.getuid()) || (entry.mode & 0o077) !== 0) {
    throw new Error('The separate identity folder is unavailable. Your original work is still in place.')
  }
}

/** Reuse the application entry with its own Store, native state and local sockets. */
export async function openNewIdentityWindow(input: { userData: string; executable: string; application?: string }): Promise<void> {
  const userData = await realpath(input.userData) + '.new-identity'
  const key = createHash('sha256').update(userData).digest('hex').slice(0, 20)
  const runtime = join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), `amux-setup-${process.getuid?.()}-${key}`)
  await ensurePrivateDirectory(userData)
  await ensurePrivateDirectory(runtime)
  const state = join(userData, 'runtime-state')
  await ensurePrivateDirectory(state)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:AGENTMUX_|CTXMUX_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|NODE_PATH$)/u.test(key)))
  Object.assign(env, {
    AGENTMUX_DESKTOP_NEW_IDENTITY: '1',
    AGENTMUX_DESKTOP_USER_DATA: userData,
    AGENTMUX_RUNTIME_DIRECTORY: runtime,
    AGENTMUX_STATE_DIRECTORY: state
  })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.executable, input.application === undefined ? [] : [input.application], { env, detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
