import { getFileTypeIcon } from '../lib/file-type-icons'

/** The same compact path hierarchy for Source, Diff and decoded file readers. */
export function FilePathLabel({ path }: { path: string }) {
  const parts = path.split(/[\\/]/)
  const name = parts.pop() ?? path
  const parent = parts.join('/')
  const Icon = getFileTypeIcon(name)
  return <span className="file-path-label editor-header__path" title={path}>
    <Icon size={13} aria-hidden="true" />
    {parent ? <span className="file-path-label__parent">{parent}<span aria-hidden="true"> / </span></span> : null}
    <span className="file-path-label__name">{name}</span>
  </span>
}
