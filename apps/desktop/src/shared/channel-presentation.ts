/** First-party presentation metadata, shared by the settings modules and their ConfigOwner query. */
export const CHANNEL_PRESENTATIONS = {
  lark: { adapterId: 'feishu', title: 'Lark' },
  discord: { adapterId: 'discord', title: 'Discord' },
  telegram: { adapterId: 'telegram', title: 'Telegram' }
} as const

/** Absence is an authored choice; inherited object properties are not adapter preferences. */
export function channelHeaderChoice(saved: Readonly<Record<string, boolean>> | undefined, adapterId: string): boolean | null {
  return saved && Object.hasOwn(saved, adapterId) ? saved[adapterId]! : null
}
