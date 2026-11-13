/** Registers one book's URLs. Each format adapter alone owns its section/resource references. */
export class BookResources {
  #urls = new Set<string>()
  #disposed = false

  has = (url: string | null | undefined): boolean => typeof url === 'string' && this.#urls.has(url)

  createObjectURL = (blob: Blob): string => {
    if (this.#disposed) throw new DOMException('The book was closed', 'AbortError')
    const url = URL.createObjectURL(blob)
    this.#urls.add(url)
    return url
  }

  revokeObjectURL = (url: string): void => {
    if (!this.#urls.delete(url)) return
    URL.revokeObjectURL(url)
  }

  destroy(): void {
    this.#disposed = true
    for (const url of [...this.#urls]) this.revokeObjectURL(url)
  }
}
