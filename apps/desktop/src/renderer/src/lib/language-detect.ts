function extname(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.')
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (lastDot <= lastSep) return ''
  return filePath.slice(lastDot)
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  // Monaco maps TSX/CTS/MTS to typescript and JSX/MJS/CJS to javascript.
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.cts': 'typescript',
  '.mts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.jsonl': 'jsonl',
  '.ipynb': 'json',
  '.md': 'markdown',
  '.mdx': 'mdx',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.svg': 'xml',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.bat': 'bat',
  '.cmd': 'bat',
  '.ps1': 'powershell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.dockerfile': 'dockerfile',
  '.proto': 'proto',
  '.lua': 'lua',
  '.r': 'r',
  '.scala': 'scala',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.clj': 'clojure',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
  '.sv': 'systemverilog',
  '.svh': 'systemverilog',
  '.v': 'verilog',
  '.vh': 'verilog',
  '.tf': 'hcl',
  '.hcl': 'hcl',
  '.prisma': 'graphql'
}

const FILENAME_TO_LANGUAGE: Record<string, string> = {
  Dockerfile: 'dockerfile',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.editorconfig': 'ini',
  '.env': 'ini',
  '.env.local': 'ini',
  '.env.development': 'ini',
  '.env.production': 'ini'
}

export const DETECTABLE_LANGUAGE_IDS = Object.freeze(
  [...new Set([...Object.values(EXT_TO_LANGUAGE), ...Object.values(FILENAME_TO_LANGUAGE), 'plaintext'])]
    .sort()
)

export function getUnregisteredDetectedLanguageIds(registeredIds: Iterable<string>): string[] {
  const registered = new Set(registeredIds)
  return DETECTABLE_LANGUAGE_IDS.filter((id) => !registered.has(id))
}

export function detectLanguage(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  const filename = parts.at(-1)!
  if (FILENAME_TO_LANGUAGE[filename]) return FILENAME_TO_LANGUAGE[filename]
  return EXT_TO_LANGUAGE[extname(filename).toLowerCase()] ?? 'plaintext'
}
