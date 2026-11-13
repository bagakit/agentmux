import { iconMaskDataUrl, iconSvgDataUrl, iconShapes, type SemanticIconId } from '@agentmux/client-ui/icons'
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

export function excalidrawIconCss(theme: Pick<ResolvedTheme, 'value' | 'variant'>): string {
  const controls: [string, SemanticIconId][] = Object.entries(EXCALIDRAW_SEMANTIC_ICONS)
    .map(([control, semantic]) => [`.file-excalidraw-preview .excalidraw ${control} svg`, semantic])
  const selectArrow = iconSvgDataUrl(iconShapes('control.select-open', theme.value.icons), theme.value.iconStyle, theme.variant.colors.text)
  const selectCss = `.file-excalidraw-preview .excalidraw .dropdown-select,body>.excalidraw .dropdown-select{--dropdown-icon:${selectArrow}}`
  return selectCss + '\n' + [...controls, ...EXCALIDRAW_PORTAL_ICONS].map(([selector, semantic]) => {
    const mask = iconMaskDataUrl(iconShapes(semantic, theme.value.icons), theme.value.iconStyle)
    return `${selector}{background-color:currentColor;mask-image:${mask};-webkit-mask-image:${mask};mask-size:contain;-webkit-mask-size:contain;mask-position:center;-webkit-mask-position:center;mask-repeat:no-repeat;-webkit-mask-repeat:no-repeat}${selector}>*{visibility:hidden}`
  }).join('\n')
}

/** Dependency UI variables consume Root roles. Scene colors and exported/user SVG stay literal. */
const EXCALIDRAW_UI_THEME_CSS = `.file-excalidraw-preview .excalidraw,body>.excalidraw{
  --ui-font:var(--font-sans);--default-bg-color:var(--surface-0);--input-bg-color:var(--surface-0);--input-border-color:var(--line);
  --input-hover-bg-color:var(--surface-2);--input-label-color:var(--text-2);--island-bg-color:var(--surface-1);
  --popup-bg-color:var(--surface-1);--popup-secondary-bg-color:var(--surface-2);--popup-text-color:var(--text);
  --icon-fill-color:var(--text);--icon-green-fill-color:var(--success);--text-primary-color:var(--text);
  --keybinding-color:var(--text-3);--link-color:var(--blue);--focus-highlight-color:var(--focus-line);
  --button-gray-1:var(--surface-2);--button-gray-2:var(--line);--button-gray-3:var(--text-3);
  --button-hover-bg:var(--surface-2);--button-active-bg:var(--surface-3);--button-active-border:var(--focus-line);
  --default-border-color:var(--line-soft);--dialog-border-color:var(--line);--sidebar-border-color:var(--line-soft);
  --sidebar-bg-color:var(--surface-1);--shadow-island:var(--elev-2);--modal-shadow:var(--elev-3);--sidebar-shadow:var(--elev-2);
  --library-dropdown-shadow:var(--elev-2);--color-surface-high:var(--surface-2);--color-surface-mid:var(--surface-1);
  --color-surface-low:var(--surface-2);--color-surface-lowest:var(--surface-0);--color-on-surface:var(--text);
  --color-primary:var(--green);--color-primary-darker:var(--green-2);--color-primary-darkest:var(--green-2);
  --color-primary-hover:var(--green-2);--color-primary-light:var(--green-bg);--color-primary-light-darker:var(--green-bg-hover);
  --color-brand-hover:var(--green-2);--color-brand-active:var(--green-2);--color-surface-primary-container:var(--green-bg);
  --color-on-primary-container:var(--green-text);--color-border-outline:var(--line);--color-border-outline-variant:var(--line-soft);
  --color-gray-0:var(--surface-0);--color-gray-10:var(--surface-0);--color-gray-20:var(--surface-1);--color-gray-30:var(--surface-2);
  --color-gray-40:var(--line);--color-gray-50:var(--text-3);--color-gray-60:var(--text-2);--color-gray-70:var(--text-2);
  --color-gray-80:var(--text);--color-gray-90:var(--text);--color-gray-100:var(--text);
  --color-disabled:var(--text-3);--color-muted:var(--line);--color-muted-darker:var(--text-3);--color-muted-darkest:var(--text);
  --button-destructive-bg-color:var(--red-bg);--button-destructive-color:var(--red-text);
  --color-danger:var(--red);--color-danger-background:var(--red-bg);--color-danger-color:var(--red-text);
  --color-warning-dark:var(--amber);--color-warning-darker:var(--amber);--color-warning-darkest:var(--amber);
  --color-warning-icon-background:var(--amber-bg);--color-warning-icon-color:var(--amber-text);--color-text-warning:var(--amber-text);
  --color-danger-dark:var(--red);--color-danger-darker:var(--red);--color-danger-darkest:var(--red);
  --color-danger-text:var(--red-text);--color-danger-icon-color:var(--red-text);--color-danger-icon-background:var(--red-bg);
  --color-warning:var(--amber-bg);--color-warning-background:var(--amber-bg);--color-warning-color:var(--amber-text);
  --color-success:var(--green-bg);--color-success-text:var(--green-text);--color-selection:var(--green);
  --border-radius-md:var(--radius-sm);--border-radius-lg:var(--radius);font-family:var(--font-sans);color:var(--text);
}
.excalidraw .ExcTextField__label,.excalidraw button,.excalidraw input,.excalidraw select{font-family:var(--font-sans)}
.file-excalidraw-preview .excalidraw .layer-ui__search-header .ExcTextField__input,body>.excalidraw .layer-ui__search-header .ExcTextField__input{background-color:var(--surface-2)}
.file-excalidraw-preview .excalidraw .library-menu-browse-button,body>.excalidraw .library-menu-browse-button{color:var(--on-accent)}
.excalidraw-tooltip{--ui-font:var(--font-sans);color:var(--text);background:var(--surface-1);box-shadow:var(--elev-2);border-radius:var(--radius-sm)}`

/** The viewer owns its CSS lifetime. User-drawn canvas/SVG content is never selected. */
export function mountExcalidrawIcons(host: Window = window): () => void {
  const style = host.document.createElement('style')
  style.dataset.excalidrawSemanticIcons = ''
  host.document.head.append(style)
  let previous = ''
  const unsubscribe = observeResolvedTheme(theme => {
    const signature = JSON.stringify([theme.value.icons, theme.value.iconStyle, theme.variant.colors.text])
    if (signature === previous) return
    style.textContent = EXCALIDRAW_UI_THEME_CSS + '\n' + excalidrawIconCss(theme)
    previous = signature
  }, host)
  return () => { unsubscribe(); style.remove() }
}
