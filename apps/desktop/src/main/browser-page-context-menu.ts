import type { ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron'
import type { SplitDirection } from '@agentmux/layout'
import type { BrowserNewPageDestination } from '../shared/browser-new-page-placement.js'
import { classifyBrowserTarget } from './browser-app-link.js'

export type BrowserMenuDestination = { destination: BrowserNewPageDestination; profileId?: string; private?: true; splitDirection?: SplitDirection }
type Action = () => void | Promise<unknown>
type Item = { label: string; enabled?: boolean; run: Action; split?: (direction: SplitDirection) => Action } | { label: string; submenu: Item[] }
export type BrowserPageMenuTemplate = Omit<MenuItemConstructorOptions, 'submenu' | 'click'> & {
  submenu?: BrowserPageMenuTemplate[]
  click?: () => boolean | void
  chooseSplit?: (direction: SplitDirection) => boolean | void
}

export type BrowserMenuCommands = {
  isCurrent(): boolean
  profiles(): readonly { id: string; label: string }[]
  copyAddress(address: string): Action
  open(address: string, options: BrowserMenuDestination): Action
  follow(address: string): Action
  download(address: string): Action
  atHit(action: (x: number, y: number) => void): Action
  search(text: string): Action
  back: Action
  forward: Action
  reload: Action
  reloadFrame?: Action
  savePage: Action
  print: Action
  inspect: Action
}

export function browserPageMenu(contents: WebContents, hit: ContextMenuParams, owner: BrowserMenuCommands,
  run: (action: Action) => boolean | void): BrowserPageMenuTemplate[] {
  const groups: Item[][] = []
  const { linkURL, srcURL, pageURL, frameURL, mediaType, selectionText, isEditable } = hit
  const openInTab = (address: string) => owner.open(address, { destination: 'tab' })
  const canOpen = (address: string) => isWebAddress(address) || (/^file:\/\//iu.test(frameURL || pageURL) && /^file:\/\//iu.test(address))
  if (linkURL) {
    const openable = canOpen(linkURL)
    const profileItems: Item[] = isWebAddress(linkURL) ? owner.profiles().map(({ id, label }) =>
      ({ label, run: owner.open(linkURL, { destination: 'tab', profileId: id }) })) : []
    groups.push([
      ...(openable ? [
        { label: 'Open Link in New Tab', run: openInTab(linkURL) },
        { label: 'Open Link in Split', run: owner.open(linkURL, { destination: 'region' }),
          split: (direction: SplitDirection) => owner.open(linkURL, { destination: 'region', splitDirection: direction }) },
        { label: 'Open Link in New Window', run: owner.open(linkURL, { destination: 'window' }) },
        ...(isWebAddress(linkURL) ? [{ label: 'Open Link in Private Window', run: owner.open(linkURL, { destination: 'window', private: true }) }] : []),
        { label: 'Open Link Here', run: owner.follow(linkURL) }
      ] : classifyBrowserTarget(linkURL).kind === 'hand-off' ? [{ label: 'Open Link', run: owner.follow(linkURL) }] : []),
      ...(profileItems.length ? [{ label: 'Open Link as', submenu: profileItems }] : []),
      ...(openable ? [{ label: 'Save Link As…', run: owner.download(linkURL) }] : []),
      { label: 'Copy Link Address', run: owner.copyAddress(linkURL) }
    ])
  }
  if (mediaType === 'image' || mediaType === 'canvas') {
    groups.push([
      ...(canOpen(srcURL) ? [{ label: 'Open Image in New Tab', run: openInTab(srcURL) }] : []),
      ...(isDownloadAddress(srcURL) ? [{ label: 'Save Image As…', run: owner.download(srcURL) }] : []),
      { label: 'Copy Image', enabled: hit.hasImageContents || mediaType === 'canvas', run: owner.atHit((x, y) => contents.copyImageAt(x, y)) },
      ...(srcURL && mediaType === 'image' ? [{ label: 'Copy Image Address', run: owner.copyAddress(srcURL) }] : [])
    ])
  }
  if (mediaType === 'audio' || mediaType === 'video') {
    const media = mediaType === 'audio' ? 'Audio' : 'Video'
    groups.push([
      ...(canOpen(srcURL) ? [{ label: `Open ${media} in New Tab`, run: openInTab(srcURL) }] : []),
      ...(isDownloadAddress(srcURL) ? [{ label: `Save ${media} As…`, enabled: hit.mediaFlags.canSave, run: owner.download(srcURL) }] : []),
      ...(srcURL ? [{ label: `Copy ${media} Address`, run: owner.copyAddress(srcURL) }] : []),
      ...(mediaType === 'video' && !hit.mediaFlags.inError ? [
        { label: 'Save Video Frame As…', run: owner.atHit((x, y) => contents.saveVideoFrameAs(x, y)) },
        { label: 'Copy Video Frame', run: owner.atHit((x, y) => contents.copyVideoFrameAt(x, y)) }
      ] : [])
    ])
  }
  if (!linkURL && mediaType === 'none' && !isEditable && !selectionText && pageURL) {
    groups.push([
      { label: 'Back', enabled: contents.navigationHistory.canGoBack(), run: owner.back },
      { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), run: owner.forward },
      { label: 'Reload', run: owner.reload },
      { label: 'Save Page As…', run: owner.savePage },
      { label: 'Print…', run: owner.print },
      { label: 'Copy Page Address', run: owner.copyAddress(pageURL) },
      ...(owner.reloadFrame ? [
        { label: 'Reload Frame', run: owner.reloadFrame },
        ...(canOpen(frameURL) ? [{ label: 'Open Frame in New Tab', run: openInTab(frameURL) }] : [])
      ] : [])
    ])
  }
  function template(item: Item): BrowserPageMenuTemplate {
    if ('submenu' in item) return { label: item.label, submenu: item.submenu.map(template) }
    const split = item.split
    return { label: item.label, enabled: item.enabled ?? true, click: () => item.enabled !== false && run(item.run),
      ...(split ? { chooseSplit: (direction: SplitDirection) => item.enabled !== false && run(split(direction)) } : {}) }
  }
  return groups.filter(group => group.length > 0).flatMap((group, index): BrowserPageMenuTemplate[] => [
    ...(index ? [{ type: 'separator' as const }] : []), ...group.map(template)
  ])
}

export type BrowserMenuAction = Action

function isWebAddress(url: string): boolean {
  return /^https?:\/\//iu.test(url)
}

function isDownloadAddress(url: string): boolean {
  return isWebAddress(url) || /^(?:blob:|data:)/iu.test(url)
}
