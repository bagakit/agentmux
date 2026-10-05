import { semanticIconComponent, type SemanticIconComponent } from '@agentmux/client-ui/icons'

const ThemeFileConfigIcon = semanticIconComponent('file.config')
const ThemeFileJsonIcon = semanticIconComponent('file.json')
const ThemeFileTextIcon = semanticIconComponent('file.text')
const ThemeFilePackageIcon = semanticIconComponent('file.package')
const ThemeFileBuildConfigIcon = semanticIconComponent('file.build-config')
const ThemeFileKeyIcon = semanticIconComponent('file.key')
const ThemeFileShellIcon = semanticIconComponent('file.shell')
const ThemeFileLockedIcon = semanticIconComponent('file.locked')
const ThemeFileArchiveIcon = semanticIconComponent('file.archive')
const ThemeFileAudioIcon = semanticIconComponent('file.audio')
const ThemeFileImageIcon = semanticIconComponent('file.image')
const ThemeFileCodeIcon = semanticIconComponent('file.code')
const ThemeFileVideoIcon = semanticIconComponent('file.video')
const ThemeFileModel3dIcon = semanticIconComponent('file.model-3d')
const ThemeFileStylesheetIcon = semanticIconComponent('file.stylesheet')
const ThemeFileFontIcon = semanticIconComponent('file.font')
const ThemeFileSpreadsheetIcon = semanticIconComponent('file.spreadsheet')
const ThemeFileDatabaseIcon = semanticIconComponent('file.database')
const ThemeFileDiffIcon = semanticIconComponent('file.diff')
const ThemeFileStructuredDataIcon = semanticIconComponent('file.structured-data')
const ThemeFileChartIcon = semanticIconComponent('file.chart')
const ThemeFileGenericIcon = semanticIconComponent('file.generic')
const ThemeFileMobileIcon = semanticIconComponent('file.mobile')


const FILE_ICON_BY_NAME: Record<string, SemanticIconComponent> = {
  '.babelrc': ThemeFileConfigIcon,
  '.dockerignore': ThemeFileConfigIcon,
  '.editorconfig': ThemeFileConfigIcon,
  '.eslintrc': ThemeFileConfigIcon,
  '.eslintrc.cjs': ThemeFileConfigIcon,
  '.eslintrc.js': ThemeFileConfigIcon,
  '.eslintrc.json': ThemeFileJsonIcon,
  '.eslintrc.yaml': ThemeFileConfigIcon,
  '.eslintrc.yml': ThemeFileConfigIcon,
  '.gitattributes': ThemeFileConfigIcon,
  '.gitignore': ThemeFileConfigIcon,
  '.npmrc': ThemeFileConfigIcon,
  '.prettierrc': ThemeFileConfigIcon,
  '.prettierrc.json': ThemeFileJsonIcon,
  '.prettierrc.yaml': ThemeFileConfigIcon,
  '.prettierrc.yml': ThemeFileConfigIcon,
  'agents.md': ThemeFileTextIcon,
  authors: ThemeFileTextIcon,
  'bun.lock': ThemeFilePackageIcon,
  'bun.lockb': ThemeFilePackageIcon,
  'cargo.lock': ThemeFilePackageIcon,
  'cargo.toml': ThemeFilePackageIcon,
  changelog: ThemeFileTextIcon,
  'changelog.md': ThemeFileTextIcon,
  'cmakelists.txt': ThemeFileBuildConfigIcon,
  codeowners: ThemeFileKeyIcon,
  'components.json': ThemeFileConfigIcon,
  'composer.json': ThemeFilePackageIcon,
  'composer.lock': ThemeFilePackageIcon,
  contributing: ThemeFileTextIcon,
  'contributing.md': ThemeFileTextIcon,
  copying: ThemeFileKeyIcon,
  dockerfile: ThemeFileBuildConfigIcon,
  gemfile: ThemeFilePackageIcon,
  'go.mod': ThemeFilePackageIcon,
  'go.sum': ThemeFilePackageIcon,
  license: ThemeFileKeyIcon,
  makefile: ThemeFileShellIcon,
  'meson.build': ThemeFileBuildConfigIcon,
  notice: ThemeFileKeyIcon,
  'package-lock.json': ThemeFilePackageIcon,
  'package.json': ThemeFilePackageIcon,
  pipfile: ThemeFilePackageIcon,
  'pnpm-lock.yaml': ThemeFilePackageIcon,
  'pnpm-workspace.yaml': ThemeFilePackageIcon,
  'poetry.lock': ThemeFilePackageIcon,
  'pom.xml': ThemeFilePackageIcon,
  'postcss.config.cjs': ThemeFileConfigIcon,
  'postcss.config.js': ThemeFileConfigIcon,
  'postcss.config.mjs': ThemeFileConfigIcon,
  'postcss.config.ts': ThemeFileConfigIcon,
  'pyproject.toml': ThemeFilePackageIcon,
  readme: ThemeFileTextIcon,
  'readme.md': ThemeFileTextIcon,
  'requirements-dev.txt': ThemeFilePackageIcon,
  'requirements.txt': ThemeFilePackageIcon,
  security: ThemeFileLockedIcon,
  'security.md': ThemeFileLockedIcon,
  'settings.gradle': ThemeFileBuildConfigIcon,
  'settings.gradle.kts': ThemeFileBuildConfigIcon,
  'tailwind.config.cjs': ThemeFileConfigIcon,
  'tailwind.config.js': ThemeFileConfigIcon,
  'tailwind.config.mjs': ThemeFileConfigIcon,
  'tailwind.config.ts': ThemeFileConfigIcon,
  todo: ThemeFileTextIcon,
  'tsconfig.json': ThemeFileConfigIcon,
  'vite.config.js': ThemeFileConfigIcon,
  'vite.config.mjs': ThemeFileConfigIcon,
  'vite.config.ts': ThemeFileConfigIcon,
  'vitest.config.js': ThemeFileConfigIcon,
  'vitest.config.mjs': ThemeFileConfigIcon,
  'vitest.config.ts': ThemeFileConfigIcon,
  'yarn.lock': ThemeFilePackageIcon
}

const FILE_ICON_BY_EXTENSION: Record<string, SemanticIconComponent> = {
  '7z': ThemeFileArchiveIcon,
  aac: ThemeFileAudioIcon,
  adoc: ThemeFileTextIcon,
  ai: ThemeFileImageIcon,
  asc: ThemeFileKeyIcon,
  astro: ThemeFileCodeIcon,
  avi: ThemeFileVideoIcon,
  avif: ThemeFileImageIcon,
  bash: ThemeFileShellIcon,
  bat: ThemeFileShellIcon,
  blend: ThemeFileModel3dIcon,
  bmp: ThemeFileImageIcon,
  br: ThemeFileArchiveIcon,
  bz2: ThemeFileArchiveIcon,
  c: ThemeFileCodeIcon,
  cc: ThemeFileCodeIcon,
  cer: ThemeFileKeyIcon,
  cfg: ThemeFileConfigIcon,
  cjs: ThemeFileCodeIcon,
  clj: ThemeFileCodeIcon,
  cmd: ThemeFileShellIcon,
  conf: ThemeFileConfigIcon,
  cpp: ThemeFileCodeIcon,
  crt: ThemeFileKeyIcon,
  cs: ThemeFileCodeIcon,
  css: ThemeFileStylesheetIcon,
  csv: ThemeFileSpreadsheetIcon,
  cts: ThemeFileCodeIcon,
  cxx: ThemeFileCodeIcon,
  dart: ThemeFileCodeIcon,
  db: ThemeFileDatabaseIcon,
  diff: ThemeFileDiffIcon,
  dmg: ThemeFileArchiveIcon,
  doc: ThemeFileTextIcon,
  docx: ThemeFileTextIcon,
  duckdb: ThemeFileDatabaseIcon,
  eot: ThemeFileFontIcon,
  eps: ThemeFileImageIcon,
  erl: ThemeFileCodeIcon,
  ex: ThemeFileCodeIcon,
  exs: ThemeFileCodeIcon,
  fbx: ThemeFileModel3dIcon,
  fish: ThemeFileShellIcon,
  flac: ThemeFileAudioIcon,
  fs: ThemeFileCodeIcon,
  fsx: ThemeFileCodeIcon,
  gif: ThemeFileImageIcon,
  glb: ThemeFileModel3dIcon,
  gltf: ThemeFileModel3dIcon,
  go: ThemeFileCodeIcon,
  gpg: ThemeFileKeyIcon,
  gql: ThemeFileStructuredDataIcon,
  gradle: ThemeFileBuildConfigIcon,
  graphql: ThemeFileStructuredDataIcon,
  gz: ThemeFileArchiveIcon,
  h: ThemeFileCodeIcon,
  hcl: ThemeFileConfigIcon,
  heic: ThemeFileImageIcon,
  hpp: ThemeFileCodeIcon,
  hrl: ThemeFileCodeIcon,
  hs: ThemeFileCodeIcon,
  htm: ThemeFileCodeIcon,
  html: ThemeFileCodeIcon,
  ico: ThemeFileImageIcon,
  ini: ThemeFileConfigIcon,
  ipynb: ThemeFileChartIcon,
  iso: ThemeFileArchiveIcon,
  java: ThemeFileCodeIcon,
  jpeg: ThemeFileImageIcon,
  jpg: ThemeFileImageIcon,
  js: ThemeFileCodeIcon,
  json: ThemeFileJsonIcon,
  json5: ThemeFileJsonIcon,
  jsonc: ThemeFileJsonIcon,
  jsx: ThemeFileCodeIcon,
  key: ThemeFileKeyIcon,
  kt: ThemeFileCodeIcon,
  kts: ThemeFileCodeIcon,
  less: ThemeFileStylesheetIcon,
  lock: ThemeFileLockedIcon,
  log: ThemeFileTextIcon,
  lua: ThemeFileCodeIcon,
  m4a: ThemeFileAudioIcon,
  m4v: ThemeFileVideoIcon,
  md: ThemeFileTextIcon,
  mdx: ThemeFileTextIcon,
  mjs: ThemeFileCodeIcon,
  mkv: ThemeFileVideoIcon,
  mmd: ThemeFileChartIcon,
  mov: ThemeFileVideoIcon,
  mp3: ThemeFileAudioIcon,
  mp4: ThemeFileVideoIcon,
  mpeg: ThemeFileVideoIcon,
  mpg: ThemeFileVideoIcon,
  mts: ThemeFileCodeIcon,
  nim: ThemeFileCodeIcon,
  nu: ThemeFileShellIcon,
  obj: ThemeFileModel3dIcon,
  ods: ThemeFileSpreadsheetIcon,
  ogg: ThemeFileAudioIcon,
  opus: ThemeFileAudioIcon,
  otf: ThemeFileFontIcon,
  p12: ThemeFileLockedIcon,
  patch: ThemeFileDiffIcon,
  pdf: ThemeFileTextIcon,
  pem: ThemeFileKeyIcon,
  pfx: ThemeFileLockedIcon,
  php: ThemeFileCodeIcon,
  pl: ThemeFileCodeIcon,
  pm: ThemeFileCodeIcon,
  png: ThemeFileImageIcon,
  ppt: ThemeFileChartIcon,
  pptx: ThemeFileChartIcon,
  prisma: ThemeFileDatabaseIcon,
  properties: ThemeFileConfigIcon,
  proto: ThemeFileStructuredDataIcon,
  ps1: ThemeFileShellIcon,
  psd: ThemeFileImageIcon,
  pub: ThemeFileKeyIcon,
  py: ThemeFileCodeIcon,
  r: ThemeFileCodeIcon,
  rar: ThemeFileArchiveIcon,
  rb: ThemeFileCodeIcon,
  rst: ThemeFileTextIcon,
  rs: ThemeFileCodeIcon,
  rtf: ThemeFileTextIcon,
  sass: ThemeFileStylesheetIcon,
  scala: ThemeFileCodeIcon,
  scss: ThemeFileStylesheetIcon,
  sh: ThemeFileShellIcon,
  sol: ThemeFileCodeIcon,
  sqlite: ThemeFileDatabaseIcon,
  sqlite3: ThemeFileDatabaseIcon,
  sql: ThemeFileDatabaseIcon,
  stl: ThemeFileModel3dIcon,
  svelte: ThemeFileCodeIcon,
  svg: ThemeFileImageIcon,
  swift: ThemeFileCodeIcon,
  tar: ThemeFileArchiveIcon,
  'tar.bz2': ThemeFileArchiveIcon,
  'tar.gz': ThemeFileArchiveIcon,
  'tar.xz': ThemeFileArchiveIcon,
  tbz2: ThemeFileArchiveIcon,
  tex: ThemeFileTextIcon,
  tf: ThemeFileConfigIcon,
  tfvars: ThemeFileConfigIcon,
  tgz: ThemeFileArchiveIcon,
  tif: ThemeFileImageIcon,
  tiff: ThemeFileImageIcon,
  toml: ThemeFileConfigIcon,
  ts: ThemeFileCodeIcon,
  tsx: ThemeFileCodeIcon,
  tsv: ThemeFileSpreadsheetIcon,
  ttf: ThemeFileFontIcon,
  txt: ThemeFileTextIcon,
  txz: ThemeFileArchiveIcon,
  vb: ThemeFileCodeIcon,
  vue: ThemeFileCodeIcon,
  wav: ThemeFileAudioIcon,
  webm: ThemeFileVideoIcon,
  webp: ThemeFileImageIcon,
  woff: ThemeFileFontIcon,
  woff2: ThemeFileFontIcon,
  xhtml: ThemeFileCodeIcon,
  xls: ThemeFileSpreadsheetIcon,
  xlsx: ThemeFileSpreadsheetIcon,
  xml: ThemeFileCodeIcon,
  xz: ThemeFileArchiveIcon,
  yaml: ThemeFileConfigIcon,
  yml: ThemeFileConfigIcon,
  zig: ThemeFileCodeIcon,
  zip: ThemeFileArchiveIcon,
  zsh: ThemeFileShellIcon
}

const COMPOUND_EXTENSIONS = ['tar.bz2', 'tar.gz', 'tar.xz']

function getFilename(filePath: string | undefined | null): string {
  if (!filePath) return ''
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
}

function getExtension(filename: string): string {
  const lowerName = filename.toLowerCase()
  const compoundExtension = COMPOUND_EXTENSIONS.find((ext) => lowerName.endsWith(`.${ext}`))
  if (compoundExtension) return compoundExtension
  const lastDot = filename.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === filename.length - 1) return ''
  return filename.slice(lastDot + 1).toLowerCase()
}

export function getFileTypeIcon(filePath: string | undefined | null): SemanticIconComponent {
  const filename = getFilename(filePath)
  if (!filename) return ThemeFileGenericIcon
  const lowerName = filename.toLowerCase()
  const exactMatch = FILE_ICON_BY_NAME[lowerName]
  if (exactMatch) return exactMatch
  if (lowerName === 'mobile emulator' || lowerName === 'simulator') return ThemeFileMobileIcon
  if (lowerName === '.env' || lowerName.startsWith('.env.')) return ThemeFileLockedIcon
  if (lowerName === 'dockerfile' || lowerName.startsWith('dockerfile.')) return ThemeFileBuildConfigIcon
  if (lowerName === 'makefile' || lowerName.startsWith('makefile.')) return ThemeFileShellIcon
  // Filename/extension matching stays deterministic for Local and SSH workspaces.
  return FILE_ICON_BY_EXTENSION[getExtension(filename)] ?? ThemeFileGenericIcon
}
