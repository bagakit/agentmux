import { iconMaskDataUrl, iconShapes, type SemanticIconId } from '@agentmux/client-ui/icons'
import { observeResolvedTheme, type ResolvedTheme } from '@agentmux/client-ui/theme'

/** Dependency CSS/test identities in our read-only viewer, independent of translated labels. */
export const EXCALIDRAW_SEMANTIC_ICONS = {
  '.zoom-in-button': 'action.zoom-in', '.zoom-out-button': 'action.zoom-out', '.reset-zoom-button': 'action.reset-view',
  '.dropdown-menu-button': 'action.menu', '.help-icon': 'action.help',
  '[data-testid="button-undo"]': 'action.undo', '[data-testid="button-redo"]': 'action.redo',
  '[data-testid="help-menu-item"]': 'action.help', '[data-testid="search-menu-button"]': 'action.search',
  '[data-testid="toolbar-hand"]': 'action.pan',
  '[data-testid="sidebar-close"]': 'action.close', '[data-testid="sidebar-dock"]': 'action.pin',
  '.layer-ui__search-header': 'action.search', '.result-nav-btn:first-child': 'navigation.down', '.result-nav-btn:last-child': 'navigation.up',
  '.sidebar-tab-trigger[id$="-trigger-search"]': 'action.search', '.sidebar-tab-trigger[id$="-trigger-library"]': 'object.library',
  '[data-testid="lib-dropdown--load"]': 'action.import', '[data-testid="lib-dropdown--export"]': 'action.export',
  '.library-menu .dropdown-menu-item:not([data-testid])': 'action.remove',
  '[data-testid="lib-dropdown--remove"]': 'action.publish', '.single-library-item--remove': 'action.close', '.library-unit__adder': 'action.create'
} as const satisfies Record<string, SemanticIconId>

// The dependency portals Dialog to body. Its HelpDialog header slots 1/2 are
// ExternalLinkIcon; slots 3/4 retain GitHub/YouTube brand identity.
const EXCALIDRAW_PORTAL_ICONS: [string, SemanticIconId][] = [
  ['.excalidraw .Dialog__close svg', 'action.close'],
  ['.excalidraw .HelpDialog__header .HelpDialog__btn:nth-child(-n+2) svg', 'action.open-external']
]

export function excalidrawIconCss(theme: Pick<ResolvedTheme, 'value'>): string {
  const controls: [string, SemanticIconId][] = Object.entries(EXCALIDRAW_SEMANTIC_ICONS)
    .map(([control, semantic]) => [`.file-excalidraw-preview .excalidraw ${control} svg`, semantic])
  return [...controls, ...EXCALIDRAW_PORTAL_ICONS].map(([selector, semantic]) => {
    const mask = iconMaskDataUrl(iconShapes(semantic, theme.value.icons), theme.value.iconStyle)
    return `${selector}{background-color:currentColor;mask-image:${mask};-webkit-mask-image:${mask};mask-size:contain;-webkit-mask-size:contain;mask-position:center;-webkit-mask-position:center;mask-repeat:no-repeat;-webkit-mask-repeat:no-repeat}${selector}>*{visibility:hidden}`
  }).join('\n')
}

/** The viewer owns its CSS lifetime. User-drawn canvas/SVG content is never selected. */
export function mountExcalidrawIcons(host: Window = window): () => void {
  const style = host.document.createElement('style')
  style.dataset.excalidrawSemanticIcons = ''
  host.document.head.append(style)
  let previous = ''
  const unsubscribe = observeResolvedTheme(theme => {
    const signature = JSON.stringify([theme.value.icons, theme.value.iconStyle])
    if (signature === previous) return
    style.textContent = excalidrawIconCss(theme)
    previous = signature
  }, host)
  return () => { unsubscribe(); style.remove() }
}
