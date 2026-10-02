import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { headlessFixture } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'

const exec = promisify(execFile)

it('the actual installer observes and releases the exact public Headless owner through its shipped fenced contract', async () => {
  const scope = await headlessFixture({ cli: true })
  try {
    const result = await exec(process.execPath, [
      resolve(import.meta.dirname, '../scripts/package-semantic-host.mjs'), '--bootstrap',
      resolve(import.meta.dirname, '../../../packages/core/dist/public-rpc-client.js')
    ], { env: scope.env, timeout: 20_000, maxBuffer: 64 * 1024 }).then(
      value => ({ ...value, exitCode: 0 }),
      error => ({ stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), exitCode: error.code })
    )
    expect(result.exitCode, 'The actual installer must observe the fenced owner and release its consumer successfully').toBe(0)
    expect(JSON.parse(result.stdout), 'The installer must obtain the original public semantic owner and Store').toEqual({
      hostProcessId: scope.owner.processId, storePath: scope.env.AGENTMUX_AGENT_SESSION_STORE
    })
    const client = await scope.client()
    expect(client.runtimeOwnerIdentity()?.ownerInstanceId).toBe(scope.owner.ownerInstanceId)
    expect(await client.listRuns()).toEqual([])
  } finally { await scope.cleanup() }
})
