/** Website-created pages only; message/terminal links retain their own preference. */
export const BROWSER_NEW_PAGE_SCENES = ['space', 'focus', 'survey'] as const
export const BROWSER_NEW_PAGE_DESTINATIONS = ['window', 'tab', 'region'] as const
export type BrowserNewPageScene = typeof BROWSER_NEW_PAGE_SCENES[number]
export type BrowserNewPageDestination = typeof BROWSER_NEW_PAGE_DESTINATIONS[number]
export type BrowserNewPagePlacement = Record<BrowserNewPageScene, BrowserNewPageDestination>

export const BROWSER_NEW_PAGE_PLACEMENT_DEFAULTS: Readonly<BrowserNewPagePlacement> = {
  space: 'region', focus: 'region', survey: 'tab'
}

/** Resolve effective defaults without creating or persisting optional preferences. */
export function resolveBrowserNewPagePlacement(
  preferences: Partial<BrowserNewPagePlacement> | undefined,
  scene: BrowserNewPageScene
): BrowserNewPageDestination {
  return preferences?.[scene] ?? BROWSER_NEW_PAGE_PLACEMENT_DEFAULTS[scene]
}
