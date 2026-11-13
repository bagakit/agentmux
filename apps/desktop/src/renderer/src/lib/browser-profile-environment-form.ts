import { parseBrowserProfileEnvironment, type BrowserProfileEnvironment } from '@agentmux/core/control'

export type EnvironmentBrand = { brand: string; version: string }
export type ProfileEnvironmentFields = {
  languages: string
  timeZone: string
  locale: string
  userAgent: string
  location: boolean
  latitude: string
  longitude: string
  accuracy: string
  screenWidth: string
  screenHeight: string
  hardwareConcurrency: string
  hints: boolean
  platform: string
  platformVersion: string
  architecture: string
  model: string
  mobile: boolean
  bitnessEnabled: boolean
  bitness: string
  wow64: 'default' | 'true' | 'false'
  brands: EnvironmentBrand[] | null
  fullVersionList: EnvironmentBrand[] | null
}
export type ProfileEnvironmentDraft = { baseRevision: string; fields: ProfileEnvironmentFields }

export function environmentFields(value?: BrowserProfileEnvironment): ProfileEnvironmentFields {
  const hints = value?.userAgentMetadata
  return {
    languages: value?.acceptLanguages?.join(', ') ?? '',
    timeZone: value?.timeZone ?? '',
    locale: value?.locale ?? '',
    userAgent: value?.userAgent ?? '',
    location: !!value?.geolocation,
    latitude: value?.geolocation ? String(value.geolocation.latitude) : '',
    longitude: value?.geolocation ? String(value.geolocation.longitude) : '',
    accuracy: value?.geolocation ? String(value.geolocation.accuracy) : '',
    screenWidth: value?.screen ? String(value.screen.width) : '',
    screenHeight: value?.screen ? String(value.screen.height) : '',
    hardwareConcurrency: value?.hardwareConcurrency === undefined ? '' : String(value.hardwareConcurrency),
    hints: !!hints,
    platform: hints?.platform ?? '',
    platformVersion: hints?.platformVersion ?? '',
    architecture: hints?.architecture ?? '',
    model: hints?.model ?? '',
    mobile: hints?.mobile ?? false,
    bitnessEnabled: hints?.bitness !== undefined,
    bitness: hints?.bitness ?? '',
    wow64: hints?.wow64 === undefined ? 'default' : (String(hints.wow64) as 'true' | 'false'),
    brands: hints?.brands ? structuredClone(hints.brands) : null,
    fullVersionList: hints?.fullVersionList ? structuredClone(hints.fullVersionList) : null
  }
}

/** Raw inputs stay untouched while editing; the same Core codec owns the submitted setting. */
export function environmentFromFields(fields: ProfileEnvironmentFields): BrowserProfileEnvironment | null {
  const number = (value: string, label: string) => {
    if (!value.trim()) throw new Error(`${label} is required.`)
    return Number(value)
  }
  const value: BrowserProfileEnvironment = {
    ...(fields.languages.trim()
      ? { acceptLanguages: fields.languages.split(',').map((value) => value.trim()) }
      : {}),
    ...(fields.timeZone.trim() ? { timeZone: fields.timeZone.trim() } : {}),
    ...(fields.locale.trim() ? { locale: fields.locale.trim() } : {}),
    ...(fields.userAgent ? { userAgent: fields.userAgent } : {}),
    ...(fields.location
      ? {
          geolocation: {
            latitude: number(fields.latitude, 'Latitude'),
            longitude: number(fields.longitude, 'Longitude'),
            accuracy: number(fields.accuracy, 'Accuracy')
          }
        }
      : {}),
    ...(fields.screenWidth.trim() || fields.screenHeight.trim()
      ? {
          screen: {
            width: number(fields.screenWidth, 'Screen width'),
            height: number(fields.screenHeight, 'Screen height')
          }
        }
      : {}),
    ...(fields.hardwareConcurrency.trim()
      ? { hardwareConcurrency: number(fields.hardwareConcurrency, 'CPU threads') }
      : {}),
    ...(fields.hints
      ? {
          userAgentMetadata: {
            platform: fields.platform,
            platformVersion: fields.platformVersion,
            architecture: fields.architecture,
            model: fields.model,
            mobile: fields.mobile,
            ...(fields.bitnessEnabled ? { bitness: fields.bitness } : {}),
            ...(fields.wow64 === 'default' ? {} : { wow64: fields.wow64 === 'true' }),
            ...(fields.brands === null ? {} : { brands: structuredClone(fields.brands) }),
            ...(fields.fullVersionList === null
              ? {}
              : { fullVersionList: structuredClone(fields.fullVersionList) })
          }
        }
      : {})
  }
  return Object.keys(value).length ? parseBrowserProfileEnvironment(value) : null
}

/** Draft validation accepts incomplete user input; it never turns that input into an applied fact. */
export function parseEnvironmentDraft(value: unknown): ProfileEnvironmentDraft {
  const invalid = () =>
    new Error(
      'The saved environment draft is unreadable. Its original bytes are kept; retry after repairing Desktop draft storage.'
    )
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const row = value as Record<string, unknown>,
    fields = row.fields as Record<string, unknown> | undefined,
    shape = environmentFields()
  if (
    typeof row.baseRevision !== 'string' ||
    !row.baseRevision ||
    !fields ||
    typeof fields !== 'object' ||
    Array.isArray(fields) ||
    Object.keys(row).some((key) => !['baseRevision', 'fields'].includes(key))
  )
    throw invalid()
  if (
    Object.keys(fields).length !== Object.keys(shape).length ||
    Object.keys(fields).some((key) => !(key in shape))
  )
    throw invalid()
  for (const [key, defaultValue] of Object.entries(shape)) {
    const item = fields[key]
    if (key === 'brands' || key === 'fullVersionList') {
      if (
        item !== null &&
        (!Array.isArray(item) ||
          item.some(
            (brand) =>
              !brand ||
              typeof brand !== 'object' ||
              Object.keys(brand).length !== 2 ||
              typeof brand.brand !== 'string' ||
              typeof brand.version !== 'string'
          ))
      )
        throw invalid()
    } else if (key === 'wow64') {
      if (!['default', 'true', 'false'].includes(item as string)) throw invalid()
    } else if (typeof item !== typeof defaultValue) throw invalid()
  }
  return structuredClone(value) as ProfileEnvironmentDraft
}
export const environmentDraftKey = (draft: ProfileEnvironmentDraft) =>
  JSON.stringify({ baseRevision: draft.baseRevision, fields: draft.fields })
