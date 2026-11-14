import { vi } from 'vitest'
// Older selected protocol consumers use this same original source listener.
// The worker remains a real OS socket/IPC process; no product endpoint is mocked.
vi.mock('node:child_process', async importOriginal => {
  const native = await importOriginal<typeof import('node:child_process')>()
  return { ...native, fork: (path: string | URL, args: string[], options: import('node:child_process').ForkOptions) => {
    const listener = String(path).endsWith('/dist/control-endpoint-listener-worker.js')
    return native.fork(listener ? new URL('../../../../packages/core/src/control-endpoint-listener-worker.ts', import.meta.url) : path, args,
      { ...options, execArgv: listener ? ['--experimental-transform-types'] : options.execArgv })
  } }
})
