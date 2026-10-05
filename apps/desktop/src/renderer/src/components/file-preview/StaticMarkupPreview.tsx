import { useEffect, useState } from 'react'
import { useVisibleWork } from '@agentmux/client-ui/use-visible-work'

// DOM sanitization and commit are synchronous; keep notebook outputs in a bounded DOM range.
const STATIC_MARKUP_MAX_BYTES = 256 * 1024
const STATIC_MARKUP_MAX_ELEMENTS = 3000
const policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'"

/** Untrusted notebook output is static, opaque-origin and has no network or host bridge. */
export function StaticMarkupPreview({ content, title }: { content: string; title: string }) {
  const { ref, visible: inView } = useVisibleWork<HTMLDivElement>()
  return <div ref={ref} className="notebook-preview__static" style={{ minHeight: 180 }}>
    {inView && <PreparedMarkup content={content} title={title} />}
  </div>
}

function PreparedMarkup({ content, title }: { content: string; title: string }) {
  const [prepared, setPrepared] = useState<{ content: string; html?: string; error?: string } | null>(null)
  useEffect(() => {
    let current = true
    // Count opening markers in linear time, including malformed unclosed tags.
    // Looking ahead for a closing '>' can backtrack quadratically before sanitization.
    if (content.length > STATIC_MARKUP_MAX_BYTES || new TextEncoder().encode(content).byteLength > STATIC_MARKUP_MAX_BYTES || (content.match(/<[a-zA-Z]/g)?.length ?? 0) > STATIC_MARKUP_MAX_ELEMENTS) {
      setPrepared({ content, error: 'This output exceeds the static preview budget. Use Source to read the complete output.' })
      return
    }
    void import('dompurify').then(({ default: createPurifier }) => {
      if (!current) return
      // DOMPurify's URI regexp also checks SVG geometry attributes. Apply our
      // stricter offline rule only to URLs, on an instance owned by this output.
      const purifier = createPurifier(window)
      purifier.addHook('uponSanitizeAttribute', (_node, attribute) => {
        if (['href', 'xlink:href', 'src', 'poster', 'background'].includes(attribute.attrName) &&
          !/^(?:#|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(attribute.attrValue.trim())) attribute.keepAttr = false
      })
      const clean = purifier.sanitize(content, {
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'base', 'meta', 'link', 'foreignObject', 'animate', 'set'],
        FORBID_ATTR: ['srcdoc', 'srcset', 'target', 'action', 'formaction', 'autofocus']
      })
      if (current) setPrepared({ content, html: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>body{margin:8px;color:#333;font:14px system-ui;overflow-wrap:anywhere}img,svg{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${clean}</body></html>` })
    }).catch(error => { if (current) setPrepared({ content, error: String(error) }) })
    return () => { current = false }
  }, [content])
  if (prepared?.content !== content) return <span role="status">Preparing output…</span>
  if (prepared.error) return <span role="alert">{prepared.error}</span>
  return <iframe title={title} sandbox="" referrerPolicy="no-referrer" srcDoc={prepared.html} style={{ width: '100%', minHeight: 180, border: 0 }} />
}
