import { fixtureIso as _hygiene_fixtureIso } from "../scripts/lib/fixture-values.mjs"
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { accountUsageScript } from '../src/renderer/src/components/settings/account-usage-template'

const exec = promisify(execFile), fixture = resolve('apps/desktop/scripts/fixtures/toolkit-template/query.mjs')
async function query(mode: string, script = accountUsageScript, key = 'account:target') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-template-query-'))), log = join(directory, 'calls.jsonl')
  let stdout = '', stderr = '', exitCode = 0
  try { ({ stdout, stderr } = await exec(process.execPath, ['--input-type=module', '--eval', script, '--', process.execPath, key, fixture, mode, log], { cwd: directory })) }
  catch (error: any) { stdout = error.stdout; stderr = error.stderr; exitCode = error.code }
  const calls = await readFile(log, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(JSON.parse)).catch(() => [])
  if (process.env.AGENTMUX_TOOLKIT_TEMPLATE_EVIDENCE) await writeFile(join(process.env.AGENTMUX_TOOLKIT_TEMPLATE_EVIDENCE, `query-${mode}-${key.replace(/[^a-z]/gu, '_')}.json`), JSON.stringify({ mode, key, exitCode, stdout, stderr, calls, scriptSHA256: createHash('sha256').update(script).digest('hex') }, null, 2))
  await rm(directory, { recursive: true })
  return { stdout, stderr, exitCode, calls, directory }
}
describe('editable account usage template actual external process', () => {
  it('reads the exact second account once and distinguishes window reset from card expiry and source freshness', async () => {
    const result = await query('json')
    expect(result.exitCode).toBe(0)
    expect(result.calls).toEqual([{ args: ['json', expect.any(String)], cwd: result.directory }])
    expect(result.stdout).toContain('Account: account:target')
    expect(result.stdout).toContain('Scope: fixture pool')
    expect(result.stdout).toContain('Remaining: 87.5%')
    expect(result.stdout).toContain('Natural reset: ')
    expect(result.stdout).toContain('Secondary window\n  Remaining: Not reported')
    expect(result.stdout).toContain('Available reset cards: 3')
    expect(result.stdout).toContain('Card records supplied: 1')
    expect(result.stdout).toContain(("Granted: " + _hygiene_fixtureIso(20995200000)))
    expect(result.stdout).toContain(("Card expires: " + _hygiene_fixtureIso(28857600000)))
    expect(result.stdout).toContain('Reset history is inconsistent')
    expect(result.stdout).toContain('Credit balance: 4.25')
    expect(result.stdout).toContain('Source: cached fixture')
    expect(result.stdout).toContain('Usage refresh: http_error')
    expect(result.stdout).toContain('Refresh issue: fixture_unavailable')
    expect(result.stdout).not.toContain('Available reset cards: 99')
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(32 * 1024)
  })
  it('keeps visible null and absent card details unknown while source-reported zero stays zero', async () => {
    const unknown = await query('unknown'), zero = await query('zero')
    expect(unknown.exitCode).toBe(0); expect(zero.exitCode).toBe(0)
    expect(unknown.calls).toHaveLength(1); expect(zero.calls).toHaveLength(1)
    expect(unknown.stdout).toContain('Available reset cards: Not reported')
    expect(unknown.stdout).toContain('Card details: Not reported')
    expect(unknown.stdout).toContain('Source updated: Not reported')
    expect(zero.stdout).toContain('Available reset cards: 0')
    expect(zero.stdout).toContain('Credit balance: 0')
    expect(zero.stdout).toContain('Card details: Not reported')
  })
  it('edits the same script adapter for a second newline-framed external output without a Main parser', async () => {
    const anchor = 'function decodeQueryOutput(text) { return JSON.parse(text) }'
    expect(accountUsageScript.split(anchor)).toHaveLength(2)
    const edited = accountUsageScript.replace(anchor, "function decodeQueryOutput(text) { return text.trim().split('\\n').map(line => JSON.parse(line)).at(-1) }")
    const result = await query('lines', edited)
    expect(result.exitCode).toBe(0); expect(result.calls).toHaveLength(1)
    expect(result.stdout).toContain('Account: account:target')
    expect(result.stdout).toContain('Available reset cards: 3')
  })
  it('fails an authoritative query and refuses missing or ambiguous exact keys without selecting another row', async () => {
    const failed = await query('failed'), missing = await query('json', accountUsageScript, 'account:missing'), duplicate = await query('duplicate')
    expect([failed.exitCode, missing.exitCode, duplicate.exitCode]).toEqual([1, 1, 1])
    expect(failed.stderr).toContain('Account query failed: exit 2')
    expect(missing.stderr).toContain('found 0. No other account was selected')
    expect(duplicate.stderr).toContain('found 2. No other account was selected')
    const unconfigured = await query('json', accountUsageScript, '')
    expect(unconfigured.exitCode).toBe(1); expect(unconfigured.calls).toEqual([])
    expect(unconfigured.stderr).toContain('Choose a query executable and an exact account_key')
  })
})
