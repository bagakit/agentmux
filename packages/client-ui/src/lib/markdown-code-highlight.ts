const grammars = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'),
  json: () => import('highlight.js/lib/languages/json'),
  bash: () => import('highlight.js/lib/languages/bash'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  ini: () => import('highlight.js/lib/languages/ini'),
  sql: () => import('highlight.js/lib/languages/sql'),
  rust: () => import('highlight.js/lib/languages/rust'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  c: () => import('highlight.js/lib/languages/c'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile')
}
type Language = keyof typeof grammars
const aliases: Record<string, Language> = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', shell: 'bash', html: 'xml', svg: 'xml', yml: 'yaml', toml: 'ini', md: 'markdown', rs: 'rust', 'c++': 'cpp', docker: 'dockerfile' }
const loaded = new Map<Language, Promise<void>>()

export async function highlightMarkdownCode(code: string, requested: string): Promise<string | null> {
  const normalized = requested.trim().toLowerCase()
  const language = aliases[normalized] ?? (Object.hasOwn(grammars, normalized) ? normalized as Language : null)
  if (!language) return null
  const { default: highlighter } = await import('highlight.js/lib/core')
  let ready = loaded.get(language)
  if (!ready) {
    ready = grammars[language]().then(module => { highlighter.registerLanguage(language, module.default) })
    loaded.set(language, ready)
    void ready.catch(() => loaded.delete(language))
  }
  await ready
  // highlight.js escapes source; only its token markup reaches the DOM, never raw source HTML.
  return highlighter.highlight(code, { language, ignoreIllegals: true }).value
}
