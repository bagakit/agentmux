import { createHash } from 'node:crypto'
import type { ConnectionSetupAdapter, SetupProfileDesired, SetupProfilePlan } from '../../connection-setup-adapter.js'
import { applicationRequest } from './setup-session.js'
import { feishuProfilePublicationDraft } from './setup-publication.js'

type Profile = NonNullable<NonNullable<ConnectionSetupAdapter['applicationConfiguration']>['applicationProfile']>
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const read = (value: string | undefined) => { try { return value === undefined ? null : record(JSON.parse(value)) } catch { return null } }
const label = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
const description = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0')
function imageUrl(value: unknown): value is string {
  if (!label(value)) return false
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash } catch { return false }
}
function png(value: string): { bytes: Buffer; width: number; height: number; sha256: string } | null {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value) || (value.length - 22) % 4 || value.length > Math.ceil(512 * 1024 / 3) * 4 + 22) return null
  const encoded = value.slice(22), bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded || bytes.length < 33 || bytes.length > 512 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  return width && height ? { bytes, width, height, sha256: createHash('sha256').update(bytes).digest('hex') } : null
}

/** Full base_info is a replacement. All configured locales and unrelated locale fields survive. */
function profilePlan(desired: SetupProfileDesired, applicationState: string, avatarUploadState?: string): SetupProfilePlan {
  const unknown: SetupProfilePlan = { baseline: 'unknown', privateIntent: null, matches: 'unknown' }, base = read(applicationState)
  if (!Object.keys(desired).length || desired.name !== undefined && !label(desired.name) || desired.description !== undefined && !description(desired.description) || desired.avatarSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(desired.avatarSha256)) return unknown
  if (!base || !label(base.name) || !description(base.desc) || !label(base.primaryLang) || !Array.isArray(base.langs) || !base.langs.length || !base.langs.every(label) || new Set(base.langs).size !== base.langs.length || !base.langs.includes(base.primaryLang)) return unknown
  const originalI18n = record(base.i18n)
  if (!originalI18n || base.langs.some(lang => !Object.hasOwn(originalI18n, lang) || !record(originalI18n[lang]))) return unknown
  const pending: SetupProfilePlan = { baseline: 'confirmed', privateIntent: null, matches: 'unknown' }
  const i18n = structuredClone(originalI18n), name = desired.name ?? base.name, desc = desired.description ?? base.desc
  let matched = (desired.name === undefined || base.name === desired.name) && (desired.description === undefined || base.desc === desired.description)
  for (const lang of base.langs) {
    const block = record(i18n[lang])!
    if (desired.name !== undefined) { matched &&= block.name === desired.name; block.name = desired.name }
    if (lang === base.primaryLang && desired.description !== undefined) { matched &&= block.description === desired.description; block.description = desired.description }
  }
  let avatar: string | undefined
  if (desired.avatarSha256 !== undefined) {
    const uploaded = read(avatarUploadState)
    if (!uploaded || uploaded.sha256 !== desired.avatarSha256 || !imageUrl(uploaded.url)) return pending
    avatar = uploaded.url
    matched &&= base.avatar === avatar
  } else if (base.avatar !== undefined) {
    if (!imageUrl(base.avatar)) return unknown
    avatar = base.avatar
  }
  return { baseline: 'confirmed', matches: matched ? 'matched' : 'different', privateIntent: JSON.stringify({ kind: 'update-application-profile', body: { name, desc, languages: base.langs, i18n, ...(avatar === undefined ? {} : { avatar }) } }) }
}

/** Only these finite native leaves write existing application metadata; authentication stays owner-bound. */
export const feishuApplicationProfile: Profile = {
  plan: async (...args) => profilePlan(...args),
  async uploadAvatar(input, signal) {
    const image = png(input.pngDataUrl)
    if (!image) return { kind: 'unknown' }
    const body = new FormData()
    body.append('file', new Blob([new Uint8Array(image.bytes)], { type: 'image/png' }), 'avatar.png')
    body.append('uploadType', '4'); body.append('isIsv', 'false'); body.append('scale', JSON.stringify({ width: image.width, height: image.height }))
    const { payload, ...continuation } = await applicationRequest(input, '/developers/v1/app/upload/image', body, signal)
    const data = record(payload?.data)
    return data && imageUrl(data.url) ? { kind: 'accepted', privateState: JSON.stringify({ url: data.url, width: image.width, height: image.height, sha256: image.sha256 }), ...continuation } : { kind: 'unknown', ...continuation }
  },
  async update(input, signal) {
    const intent = read(input.privateIntent), body = record(intent?.body)
    if (intent?.kind !== 'update-application-profile' || !body || Object.keys(body).some(key => !['name', 'desc', 'languages', 'i18n', 'avatar'].includes(key)) || !label(body.name) || !description(body.desc) || !Array.isArray(body.languages) || !body.languages.length || !body.languages.every(label) || new Set(body.languages).size !== body.languages.length || !record(body.i18n) || body.languages.some(lang => !Object.hasOwn(body.i18n as object, lang) || !record((body.i18n as Record<string, unknown>)[lang])) || body.avatar !== undefined && !imageUrl(body.avatar)) return { kind: 'unknown' }
    const { payload, ...continuation } = await applicationRequest(input, '/developers/v1/base_info/' + encodeURIComponent(input.application.appId), { clientId: input.application.appId, ...body }, signal)
    return payload ? { kind: 'accepted', privateState: JSON.stringify(payload), ...continuation } : { kind: 'unknown', ...continuation }
  },
  publicationDraft: async (states, notes) => feishuProfilePublicationDraft(states, notes)
}
