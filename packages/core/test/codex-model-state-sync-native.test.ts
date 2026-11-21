import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it.skipIf(process.env.AMX_MODEL_SYNC_MODE !== 'native')('the installed native TUI and original producer reach actual Core, Main and compiled CLI in both directions without another model turn', async () => {
  if (process.platform !== 'darwin') throw new Error('The installed native model protocol qualification requires its actual macOS process owner.')
  if (!process.env.AMX_INFORMATION_CANDIDATE) throw new Error('The exact compiled Core/Providers candidate is required.')
  const result = await promisify(execFile)(process.execPath, ['--experimental-transform-types',
    resolve(import.meta.dirname, 'fixtures/codex-model-state-native-check.mjs')], { env: process.env, timeout: 55000, maxBuffer: 1024 * 1024 })
  const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
  expect(receipt).toMatchObject({ phase: 'passed', version: expect.any(String), setup: { turns: 1 }, cleanup: true })
  expect(receipt.version.trim()).not.toBe('')
  expect(receipt.nativeBinary.sha256).toMatch(/^[0-9a-f]{64}$/u)
  expect(receipt.setup.modelHttpRequests).toBeGreaterThanOrEqual(1)
  expect(receipt.nativeRequests['thread/settings/update']).toBe(1)
  expect(receipt.originalProducerSettingsNotifications).toBeGreaterThanOrEqual(2)
}, 60000)
