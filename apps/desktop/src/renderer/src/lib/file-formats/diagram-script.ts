/** Only packaged assets are loaded, inside the disposable diagram WebContents. */
export function loadDiagramScript(url: URL): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url.href
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Unable to load packaged diagram asset: ${url.pathname}`))
    document.head.append(script)
  })
}
