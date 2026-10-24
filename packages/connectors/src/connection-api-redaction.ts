import { Buffer } from 'node:buffer'
import type { ConnectionApiJson } from '@agentmux/core/connections'

const protectedFields = new Set(['token', 'accesstoken', 'refreshtoken', 'tenantaccesstoken', 'useraccesstoken', 'appaccesstoken', 'bottoken', 'webhooktoken', 'verificationtoken', 'appsecret', 'clientsecret', 'secret', 'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'password', 'privatekey', 'sessionkey', 'encryptkey', 'encryptionkey', 'signingsecret', 'appticket'])
const secretField = (key: string) => protectedFields.has(key.replace(/[-_ ]/gu, '').toLowerCase())
/** Values live only for this original admitted request; neither registration nor raw outcomes are persisted. */
export class ConnectionApiRedaction {
  private readonly secrets = new Set<string>()
  private readonly replacements = new Set<string>()
  protect(value: string): void {
    if (!value || this.secrets.has(value)) return
    this.secrets.add(value)
    const escaped = JSON.stringify(value).slice(1, -1)
    let percent: string
    try { percent = encodeURIComponent(value) } catch { percent = escaped }
    for (const variant of [value, escaped, percent, percent.replace(/%[A-F0-9]{2}/gu, match => match.toLowerCase()), percent.replace(/%20/gu, '+'), encodeURIComponent(percent), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')]) if (variant) this.replacements.add(variant)
  }
  sanitize(input: ConnectionApiJson): { value: ConnectionApiJson; redacted: boolean } {
    const collect = (value: ConnectionApiJson, sensitive = false): void => {
      if (typeof value === 'string') { if (sensitive) this.protect(value); return }
      if (Array.isArray(value)) { for (const item of value) collect(item, sensitive); return }
      if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) collect(item, sensitive || secretField(key))
    }
    collect(input)
    const variants = [...this.replacements].sort((a, b) => b.length - a.length)
    const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/%((?:25)*)([0-9a-f])([0-9a-f])/giu,
      (_match, percent: string, first: string, second: string) => '%' + percent + [first, second].map(hex => /[a-f]/iu.test(hex) ? `[${hex.toLowerCase()}${hex.toUpperCase()}]` : hex).join(''))
    const pattern = variants.length ? new RegExp(variants.map(literal).join('|'), 'gu') : null
    let redacted = false
    const text = (value: string): string => {
      return pattern ? value.replace(pattern, () => { redacted = true; return '[redacted]' }) : value
    }
    const visit = (value: ConnectionApiJson): ConnectionApiJson => {
      if (typeof value === 'string') return text(value)
      if (Array.isArray(value)) return value.map(visit)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        const safeKey = text(key)
        if (secretField(key)) { redacted = true; return [safeKey, '[redacted]'] }
        return [safeKey, visit(item)]
      }))
      return value
    }
    const value = visit(input)
    return { value, redacted }
  }
}
