import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)

it('ships readable system Markdown and serves the real installed CLI offline without Node capabilities in Browser consumers', async () => {
  const result = await exec(process.execPath, [fileURLToPath(new URL('../scripts/verify-system-guides.mjs', import.meta.url)), '--package-proof'], {
    maxBuffer: 8 * 1024 * 1024
  })
  expect(result.stderr).toBe('')
  const proof = JSON.parse(result.stdout)
  expect(proof.passed).toBe(true)
  expect(proof.package.markdownFiles).toBeGreaterThan(proof.package.modules)
  expect(proof.package.modules).toBeGreaterThan(1)
  expect(proof.package.commands).toBeGreaterThan(proof.package.modules)
  expect(proof.package.cliReads).toBeGreaterThan(proof.package.modules)
  expect(proof.package.endpointConnections).toBe(0)
  expect(proof.package.relativeLinks).toBeGreaterThan(0)
  expect(proof.package.codeOwnerLinks).toBeGreaterThan(0)
  expect(proof.browser).toMatchObject({ generatedConsumed: true, envelopeRendered: true, nodeGlobalsRequired: false,
    unrelatedGuideIsolated: true })
}, 180_000)

it('rejects source drift and unregistered module guides and detects successful-generation consumer disconnects', async () => {
  const result = await exec(process.execPath, [fileURLToPath(new URL('../scripts/verify-system-guides.mjs', import.meta.url)), '--source-proof'], {
    maxBuffer: 8 * 1024 * 1024
  })
  expect(result.stderr).toBe('')
  const proof = JSON.parse(result.stdout)
  expect(proof.passed).toBe(true)
  expect(proof.mutations.passed).toBe(true)
  expect(proof.mutations.count).toBeGreaterThan(0)
  expect(proof.mutations.cases.every((item: { killed: boolean }) => item.killed)).toBe(true)
  expect(proof.mutations.cases).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'actual-command-registration-oracle' }),
    expect.objectContaining({ kind: 'official-check-guides-type-oracle' }),
    expect.objectContaining({ kind: 'official-check-guides-command-oracle' }),
    expect.objectContaining({ kind: 'successful-generation-consumer-output' })
  ]))
}, 120_000)
