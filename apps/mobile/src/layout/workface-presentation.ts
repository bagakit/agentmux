/** Layout facts only. An explicit feature selection and its original owner stay outside this module. */
export type MobileWorkfaceLayout = Readonly<{ split: boolean; short: boolean }>
export type MobilePanePresentation = Readonly<{ presented: boolean; observed: boolean }>
export type MobileWorkfacePresentation = Readonly<{
  split: boolean; navigation: MobilePanePresentation; content: MobilePanePresentation
}>
const single = { split: false, short: false }, singleShort = { split: false, short: true }
const split = { split: true, short: false }, splitShort = { split: true, short: true }
export const MOBILE_WORKFACE_SPLIT_MIN_WIDTH = 600
export function mobileWorkfaceLayout({ width, height }: { width: number; height: number }): MobileWorkfaceLayout {
  return width >= MOBILE_WORKFACE_SPLIT_MIN_WIDTH ? height < 440 ? splitShort : split : height < 440 ? singleShort : single
}

/** Presented panes survive an inactive overlay; observed panes alone qualify active reads.
 * Retention remains the feature's visited tree/key, and no pane selects an object. */
export function workfacePanes({ active, split, hasSelection }: { active: boolean; split: boolean; hasSelection: boolean }): MobileWorkfacePresentation {
  const navigation = split || !hasSelection, content = split || hasSelection
  return { split, navigation: { presented: navigation, observed: active && navigation },
    content: { presented: content, observed: active && hasSelection } }
}
