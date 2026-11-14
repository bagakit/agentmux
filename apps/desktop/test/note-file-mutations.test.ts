// @vitest-environment node
import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

// The removed Main extension-based wrapper is replaced by the production Source
// owner. These original lease assertions now use real Notes locks and Native IO.
it('consumes the original Notes lease through Source creation, move and delete', async () => {
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/vitest.file-path-client.config.mts', '--maxWorkers=1', '-t', 'original.*lease'], {
    cwd: resolve(import.meta.dirname, '../../..'), env: { ...process.env, AGENTMUX_TEST_FILE_CLIENT_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  expect(code, output).toBe(0); expect(output).toMatch(/2 passed/)
}, 120000)
