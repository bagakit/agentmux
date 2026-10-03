import { fixtureIso as _hygiene_fixtureIso } from "../../lib/fixture-values.mjs"
import { appendFileSync, readFileSync } from 'node:fs'

const [requestedMode, log, modeFile] = process.argv.slice(2)
const mode = modeFile ? readFileSync(modeFile, 'utf8').trim() : requestedMode
appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\n')
if (mode === 'failed') { console.error('Controlled query unavailable'); process.exit(2) }
const now = Math.floor(Date.now() / 1000)
const selected = { account_key: 'account:target', usage: { source: 'cached fixture', updated_at: now - 120,
  primary: { used_percent: 12.5, window_minutes: 300, resets_at: now + 3600 }, secondary: null,
  credits: { balance: '4.25' }, reset_credits: 3,
  reset_credit_details: { available_count: 3, total_earned_count: 1, credits: [
    { id: 'card-one', title: 'Reset entitlement', reset_type: 'window', status: 'source-state',
      granted_at: _hygiene_fixtureIso(20995200000, "second"), expires_at: _hygiene_fixtureIso(28857600000, "second") }
  ] }, refresh: { status: 'http_error', error_code: 'fixture_unavailable' } } }
if (mode === 'unknown') selected.usage = { source: '', updated_at: null, primary: null, secondary: null,
  credits: null, reset_credits: null, reset_credit_details: null, refresh: { status: '' } }
if (mode === 'zero') selected.usage = { source: 'reported fixture', updated_at: null, primary: null, secondary: null,
  credits: { balance: 0 }, reset_credits: 0, reset_credit_details: null, refresh: { status: 'local' } }
const data = { scope: 'fixture pool', active_account_key: mode === 'active-missing' ? null : mode === 'active-inconsistent' ? 'account:absent' : 'account:target', accounts: [
  { account_key: 'account:other', usage: { reset_credits: 99 } }, selected,
  ...(mode === 'duplicate' ? [selected] : [])
] }
if (mode === 'lines') {
  console.log(JSON.stringify({ event: 'progress', message: 'Controlled input' }))
  console.log(JSON.stringify(data))
} else console.log(JSON.stringify(data))
