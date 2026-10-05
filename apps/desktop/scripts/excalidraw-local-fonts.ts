// Reviewed against the official @excalidraw/excalidraw 0.18.1 dev and prod distributions.
// EXCALIDRAW_ASSET_PATH supplies the complete bundled fonts; the unconditional
// extra URL causes CSP violations even when the first, local source loads.
export const EXCALIDRAW_LOCAL_FONTS_VERSION = '0.18.1'

export function localizeExcalidrawFontUrls(code: string, id: string): string | undefined {
  if (!/\/@excalidraw\/excalidraw\/dist\/(?:dev|prod)\/[^/]+\.js$/.test(id.split('?')[0]!.replaceAll('\\', '/')) || !code.includes('ASSETS_FALLBACK_URL')) return
  const matches = code.match(/\b[A-Za-z_$][\w$]*\.push\(\s*new URL\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\.ASSETS_FALLBACK_URL\s*\)\s*\)/g)
  if (matches?.length !== 1) throw new Error(`Excalidraw ${EXCALIDRAW_LOCAL_FONTS_VERSION} local font distribution changed: ${id}`)
  return code.replace(matches[0], 'void 0')
}
