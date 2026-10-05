import { iconMaskDataUrl, iconShapes, type SemanticIconId } from '@agentmux/client-ui/icons'
import { observeResolvedTheme, type ResolvedTheme } from '@agentmux/client-ui/theme'

// codicon-blank is a layout spacer; symbol-customcolor is a user's literal color sample, not a theme icon.
/** Monaco's registered machine icon identities, not translated labels or business state. */
export const MONACO_SEMANTIC_ICONS = {
  close: 'action.close', 'widget-close': 'action.close', 'color-picker-close': 'action.close',
  account: 'object.user', gear: 'object.tools', tools: 'object.tools', wrench: 'object.tools', loading: 'status.loading',
  'stop-circle': 'action.stop', 'bell-slash': 'status.paused',
  'split-horizontal': 'layout.split-right', 'split-vertical': 'layout.split-down',
  'expand-all': 'editor.unfold', 'collapse-all': 'editor.fold', 'surround-with': 'editor.surround',
  'compare-changes': 'editor.diff-view', 'arrow-swap': 'editor.diff-swap', map: 'editor.diff-unchanged', move: 'editor.diff-view',
  'keyboard-tab': 'editor.accept-suggestion', 'keyboard-tab-above': 'editor.accept-suggestion-above', 'keyboard-tab-below': 'editor.accept-suggestion-below',
  'symbol-constructor': 'editor.symbol-constructor', 'symbol-null': 'editor.symbol-null', 'symbol-value': 'editor.symbol-value',
  sparkle: 'editor.code-action', 'sparkle-filled': 'editor.code-action', 'lightbulb-sparkle': 'editor.code-action', 'lightbulb-sparkle-autofix': 'editor.code-action',
  'selection': 'editor.selection', 'index-zero': 'editor.symbol-number', 'add-small': 'action.create', 'remove-small': 'editor.diff-removed',
  copy: 'action.copy', check: 'action.confirm', warning: 'status.warning', error: 'status.failed', info: 'status.info',
  'chevron-right': 'navigation.disclosure', 'chevron-left': 'navigation.back', 'chevron-up': 'navigation.up', 'chevron-down': 'navigation.down',
  'arrow-up': 'navigation.up', 'arrow-down': 'navigation.down', 'arrow-left': 'navigation.back', 'arrow-right': 'navigation.forward',
  'goto-previous-location': 'navigation.up', 'goto-next-location': 'navigation.down',
  'preserve-case': 'editor.preserve-case', 'case-sensitive': 'editor.match-case', 'whole-word': 'editor.match-word', regex: 'editor.match-regexp',
  'find-collapsed': 'editor.fold', 'find-expanded': 'editor.unfold', 'find-selection': 'editor.selection',
  'find-replace': 'editor.replace', 'find-replace-all': 'editor.replace-all',
  'find-previous-match': 'navigation.up', 'find-next-match': 'navigation.down',
  'folding-expanded': 'editor.unfold', 'folding-manual-expanded': 'editor.unfold',
  'folding-collapsed': 'editor.fold', 'folding-manual-collapsed': 'editor.fold', fold: 'editor.fold', unfold: 'editor.unfold',
  'suggest-more-info': 'navigation.disclosure', 'parameter-hints-next': 'navigation.down', 'parameter-hints-previous': 'navigation.up',
  'inline-suggestion-hints-next': 'navigation.forward', 'inline-suggestion-hints-previous': 'navigation.back',
  'marker-navigation-next': 'navigation.down', 'marker-navigation-previous': 'navigation.up',
  'extensions-warning-message': 'status.warning',
  'gutter-lightbulb': 'editor.code-action', 'gutter-lightbulb-auto-fix': 'editor.code-action',
  'gutter-lightbulb-sparkle': 'editor.code-action', 'gutter-lightbulb-aifix-auto-fix': 'editor.code-action',
  'gutter-lightbulb-sparkle-filled': 'editor.code-action', lightbulb: 'editor.code-action', 'lightbulb-autofix': 'editor.code-action',
  'hover-increase-verbosity': 'action.create', 'hover-decrease-verbosity': 'editor.diff-removed',
  'diff-insert': 'editor.diff-added', 'diff-review-insert': 'editor.diff-added',
  'diff-remove': 'editor.diff-removed', 'diff-review-remove': 'editor.diff-removed', 'diff-review-close': 'action.close',
  add: 'editor.diff-added', remove: 'editor.diff-removed', discard: 'editor.diff-revert',
  replace: 'editor.replace', 'replace-all': 'editor.replace-all',
  'symbol-method': 'editor.symbol-method', 'symbol-function': 'editor.symbol-function',
  'symbol-class': 'editor.symbol-class', 'symbol-interface': 'editor.symbol-interface', 'symbol-struct': 'editor.symbol-struct',
  'symbol-variable': 'editor.symbol-variable', 'symbol-field': 'editor.symbol-field', 'symbol-property': 'editor.symbol-property',
  'symbol-key': 'editor.symbol-key', 'symbol-keyword': 'editor.symbol-keyword',
  'symbol-module': 'editor.symbol-module', 'symbol-namespace': 'editor.symbol-namespace', 'symbol-package': 'editor.symbol-package',
  'symbol-enum': 'editor.symbol-enum', 'symbol-enum-member': 'editor.symbol-enum-member',
  'symbol-string': 'editor.symbol-string', 'symbol-text': 'editor.symbol-text', 'symbol-type-parameter': 'editor.symbol-type-parameter',
  'symbol-number': 'editor.symbol-number', 'symbol-boolean': 'editor.symbol-boolean', 'symbol-constant': 'editor.symbol-constant',
  'symbol-array': 'editor.symbol-array', 'symbol-object': 'editor.symbol-object', 'symbol-event': 'editor.symbol-event',
  'symbol-operator': 'editor.symbol-operator', 'symbol-color': 'editor.symbol-color',
  'symbol-file': 'editor.symbol-file', 'symbol-reference': 'editor.symbol-file-reference',
  'symbol-folder': 'editor.symbol-folder', 'symbol-snippet': 'editor.symbol-snippet', 'symbol-unit': 'editor.symbol-unit'
} as const satisfies Record<string, SemanticIconId>

export function monacoIconCss(theme: Pick<ResolvedTheme, 'value'>): string {
  return Object.entries(MONACO_SEMANTIC_ICONS).map(([machineId, semantic]) => {
    const mask = iconMaskDataUrl(iconShapes(semantic, theme.value.icons), theme.value.iconStyle)
    return `.monaco-editor .codicon-${machineId}::before,.monaco-menu .codicon-${machineId}::before{content:""!important;display:inline-block;width:1em;height:1em;background-color:currentColor;mask-image:${mask};-webkit-mask-image:${mask};mask-size:contain;-webkit-mask-size:contain;mask-position:center;-webkit-mask-position:center;mask-repeat:no-repeat;-webkit-mask-repeat:no-repeat}`
  }).join('\n')
}

/** One stylesheet/subscription per owning window; editor models and buttons are never rebuilt. */
export function mountMonacoIcons(host: Window = window): () => void {
  const style = host.document.createElement('style')
  style.dataset.monacoSemanticIcons = ''
  host.document.head.append(style)
  let previous = ''
  const unsubscribe = observeResolvedTheme(theme => {
    const signature = JSON.stringify([theme.value.icons, theme.value.iconStyle])
    if (signature === previous) return
    style.textContent = monacoIconCss(theme)
    previous = signature
  }, host)
  return () => { unsubscribe(); style.remove() }
}
