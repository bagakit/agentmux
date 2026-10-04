// User-owned Auth tool. Argument 1: query executable; argument 2: @active or
// an exact account_key. Edit any part for your own CLI and output. Only an
// explicit Run queries; this never logs in, renews, switches accounts or uses cards.
import { spawnSync } from 'node:child_process'

const [executable, accountKey, ...customArguments] = process.argv.slice(2)
if (!executable?.trim() || !accountKey?.trim()) {
  console.error('Choose a query executable and an account selector (@active or exact account_key) in Arguments before running.')
  process.exit(1)
}

// Local codexL reference. Edit this adapter for your own query CLI and JSON.
// --skip-api avoids remote usage refresh; the external tool may update its own
// local snapshot. Inspecting a pool does not prove which account a live Run uses.
const queryArguments = customArguments.length ? customArguments
  : ['as-inspect', 'auth', 'status', '--scope', 'global', '--skip-api', '--json']
function decodeQueryOutput(text) { return JSON.parse(text) }
function readAccounts(snapshot) { return snapshot.accounts }

const query = spawnSync(executable, queryArguments, { encoding: 'utf8', timeout: 20_000, maxBuffer: 512 * 1024 })
if (query.error || query.status !== 0) {
  const reason = query.error?.message ?? `exit ${query.status ?? 'unknown'}${query.signal ? ` (${query.signal})` : ''}`
  console.error(`Account query failed: ${reason}`)
  if (query.stderr?.trim()) console.error(query.stderr.trim().slice(0, 1024))
  process.exit(1)
}
let snapshot
try { snapshot = decodeQueryOutput(query.stdout) }
catch { console.error('Account query did not return the expected JSON. Edit decodeQueryOutput for its actual format.'); process.exit(1) }
const accounts = readAccounts(snapshot)
if (!Array.isArray(accounts)) { console.error('Account rows are not reported. Edit readAccounts for the actual response.'); process.exit(1) }
const selectedKey = accountKey === '@active' ? snapshot.active_account_key : accountKey
if (typeof selectedKey !== 'string' || !selectedKey.trim()) {
  console.error('Current global account is unknown: active_account_key was not reported. No account was selected.')
  process.exit(1)
}
const matches = accounts.filter(account => account?.account_key === selectedKey)
if (matches.length !== 1) { console.error(`Expected one exact account_key; found ${matches.length}. No other account was selected.`); process.exit(1) }
const account = matches[0], usage = account.usage ?? {}, observedAt = Date.now()
const lines = [], unknown = 'Not reported'
const text = value => typeof value === 'string' && value.trim() ? value.replace(/[\r\n\t]/gu, ' ').slice(0, 160) : unknown
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const date = value => {
  const milliseconds = typeof value === 'number' && Number.isFinite(value) ? value * 1000
    : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN
  return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15 ? milliseconds : null
}
function time(value) { const at = date(value); return at === null ? unknown : new Date(at).toISOString() }
function relativeTime(value) {
  const at = date(value)
  if (at === null) return unknown
  const minutes = Math.ceil(Math.abs(at - observedAt) / 60_000)
  return `${time(value)} (${at <= observedAt ? 'past' : 'in'} ${minutes}m at observation)`
}
function window(label, value) {
  const used = number(value?.used_percent), minutes = number(value?.window_minutes)
  lines.push('', `${label}${minutes !== null && minutes > 0 ? ` · ${minutes} minutes` : ''}`)
  lines.push(`  Remaining: ${used === null ? unknown : `${Math.round(Math.max(0, Math.min(100, 100 - used)) * 10) / 10}%`}`)
  lines.push(`  Natural reset: ${relativeTime(value?.resets_at)}`)
}

lines.push('Account usage', `Account: ${text(account.account_key)}`, `Scope: ${text(snapshot.scope)}`,
  `Observed: ${new Date(observedAt).toISOString()}`, `Source: ${text(usage.source)}`,
  `Source updated: ${relativeTime(usage.updated_at)}`, `Usage refresh: ${text(usage.refresh?.status)}`)
if (usage.refresh?.error_code) lines.push(`Refresh issue: ${text(usage.refresh.error_code)}`)
lines.push('Values are the query source’s reported snapshot. Missing metadata is not proof of zero or live freshness.')
window('Primary window', usage.primary)
window('Secondary window', usage.secondary)
const balance = usage.credits?.balance
lines.push('', `Credit balance: ${usage.credits?.unlimited === true ? 'Unlimited' :
  number(balance) !== null ? String(balance) : text(balance)}`)
const details = usage.reset_credit_details, cards = Array.isArray(details?.credits) ? details.credits : null
const available = details ? count(details.available_count) : count(usage.reset_credits)
lines.push(`Available reset cards: ${available === null ? unknown : available}`)
const total = count(details?.total_earned_count)
if (total !== null && ((available !== null && total < available) || (cards && total < cards.length))) {
  lines.push('Reset history is inconsistent; total earned is not a reliable count.')
} else if (total !== null) lines.push(`Total earned (reported): ${total}`)
if (cards === null) lines.push(`Card details: ${unknown}`)
else {
  lines.push(`Card records supplied: ${cards.length}`)
  for (const [index, card] of cards.slice(0, 24).entries()) {
    lines.push('', `${index + 1}. ${text(card?.title)} · ${text(card?.status)}`,
      `  Type: ${text(card?.reset_type)}`, `  Granted: ${time(card?.granted_at)}`,
      `  Card expires: ${relativeTime(card?.expires_at)}`)
  }
  if (cards.length > 24) lines.push(`Another ${cards.length - 24} card records were omitted to keep this result bounded.`)
}
console.log(lines.join('\n'))
