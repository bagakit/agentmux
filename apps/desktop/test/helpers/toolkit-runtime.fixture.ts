import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { supportedCtxmuxArtifactPlatform } from '@agentmux/core'
import { activateRuntime } from '../../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'
import { fixturePath } from '../../scripts/lib/fixture-values.mjs'

export interface ToolkitRuntimeCleanup {
  directory: string
  childPid: number | undefined
  childExit: 'confirmed' | 'unknown' | 'not-owned'
  namespace: 'removed' | 'retained'
  issue?: string
}

// The SDK owns the spawned ChildProcess and its exit receipt. This fixture owns
// only the directory it created; successful shutdown does not transfer ownership
// of a replacement socket or directory to the fixture.
export async function toolkitRuntime() {
  const directory = await realpath(await mkdtemp(fixturePath('tmp/amx-tk-')))
  const originalDirectory = await lstat(directory)
  const platform = supportedCtxmuxArtifactPlatform()
  if (platform === null) throw new Error('No qualified Toolkit Native artifact for this platform')
  const executable = fileURLToPath(new URL(`../../../../packages/core/vendor/ctxmux/${platform}/bin/ctxmuxd`, import.meta.url))
  const stateDir = join(directory, 'state', 'ctxmux')
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const activation = await activateRuntime({ executable, socketPath: join(directory, 'ctxmux.sock'), stateDir,
    // RunSpec.env is additive. The private producer must not leave the caller's
    // original Agent credentials available to later fixture Runs that omit them.
    env: { AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined },
    timeoutMs: 5000, childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'pipe' } })

  async function cleanup({ retainNamespace = false }: { retainNamespace?: boolean } = {}): Promise<ToolkitRuntimeCleanup> {
    const handle = activation
    const receipt: ToolkitRuntimeCleanup = { directory, childPid: handle.childPid, childExit: 'unknown', namespace: 'retained' }
    if (!handle.spawned) return { ...receipt, childExit: 'not-owned', issue: 'SDK selected an existing Runtime; this handle did not create it' }
    try {
      await handle.shutdown()
      receipt.childExit = 'confirmed'
      await handle.dispose()
      if (retainNamespace) return { ...receipt, issue: 'Retain the original namespace for failed fixture disposal evidence' }
      const current = await lstat(directory)
      if (!current.isDirectory() || current.dev !== originalDirectory.dev || current.ino !== originalDirectory.ino) {
        return { ...receipt, issue: 'Private fixture directory was replaced' }
      }
      try {
        await lstat(handle.socketPath)
        return { ...receipt, issue: 'Runtime endpoint remains after original child exit; retain its namespace' }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await rm(directory, { recursive: true })
      return { ...receipt, namespace: 'removed' }
    } catch (error) {
      return { ...receipt, issue: String(error) }
    }
  }
  return { directory, activation, executable, cleanup }
}
