import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from '../../../packages/core/test/relay-owner-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutant = process.env.AGENTMUX_MOVED_DEVICE_MUTANT
const report = process.env.AGENTMUX_MOVED_DEVICE_LOADED
if (mutant && mutant !== 'missing-storage-issue') throw Error('Unknown moved device consumer mutation')
// The moved authority, Host, durable-write fault port and RPC share one source Core.
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], {
  name: 'moved-device-fault-owner', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!['packages/core/src/device-authority.ts', 'packages/core/src/device-access.ts', 'packages/core/src/durable-write.ts',
      'apps/host/src/host.ts', 'apps/desktop/test/device-connection-identity.integration.test.ts'].includes(path)) return
    let source = original
    if (mutant && path === 'packages/core/src/device-authority.ts') {
      const anchor = '    this.connectionIssues.set(deviceId,'
      if (source.split(anchor).length !== 2) throw Error('The actual moved fault owner must match once')
      source = source.replace(anchor, '    if (false) this.connectionIssues.set(deviceId,')
    }
    if (report) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { path, originalSHA256: sha(original), loadedSHA256: sha(source) }
      source = `import { appendFileSync as __movedDeviceSource } from 'node:fs'; __movedDeviceSource(${JSON.stringify(report)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
    }
    return { code: source, map: null }
  }
}], test: { ...base.test,
  include: ['apps/desktop/test/device-connection-identity.integration.test.ts'],
  environment: 'node', maxWorkers: 1, passWithNoTests: false, testTimeout: 30000,
} })
