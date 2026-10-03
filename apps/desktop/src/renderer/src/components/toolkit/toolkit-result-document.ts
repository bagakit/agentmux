/** Optional data-only result document. It never defines executable actions or HTML. */
export type ToolkitResultDocument = { schema: 'agentmux.toolkit.result.v1'; summary: string;
  items: { label: string; value: string }[]; links: { label: string; url: string }[]; notice: string }
export function toolkitResultDocument(text: string): ToolkitResultDocument | null {
  try {
    const value = JSON.parse(text.trim())
    const short = (v: unknown) => typeof v === 'string' && v.length <= 4096
    if (value.schema !== 'agentmux.toolkit.result.v1' || !short(value.summary) || !short(value.notice) ||
        !Array.isArray(value.items) || value.items.length > 128 || !Array.isArray(value.links) || value.links.length > 16 ||
        !value.items.every((item: { label?: unknown; value?: unknown }) => item && short(item.label) && short(item.value)) ||
        !value.links.every((item: { label?: unknown; url?: unknown }) => {
          if (!item || !short(item.label) || !short(item.url)) return false
          const url = new URL(item.url as string)
          return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        })) return null
    return value
  } catch { return null }
}
