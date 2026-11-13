import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Actual standalone process, native engine, public caller and original-identity restart. */
describe('standalone Browser host public vertical slice', () => {
  it('creates, discovers, drives, stops and closes exact original native Browsers across host restart', async () => {
    const repo=resolve(import.meta.dirname,'../../..')
    const result=await promisify(execFile)(process.execPath,['apps/desktop/scripts/verify-browser-standalone.mjs','--gate','--compiled'],{cwd:repo,timeout:180_000,maxBuffer:2*1024*1024})
    expect(result.stdout).toContain('"passed":true')
    const receipt=JSON.parse(await readFile(resolve(repo,'.local/browser-standalone/gate/receipt.json'),'utf8'))
    expect(receipt.passed).toBe(true);expect(receipt.runs).toHaveLength(1);expect(receipt.runs[0].compiledDistribution).toBe(true);expect(receipt.runs[0].cases).toHaveLength(11)
  },190_000)
})
