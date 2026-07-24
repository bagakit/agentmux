import { FileCode2, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAppStore } from '../store'

export function FileExplorer() {
  const files = useAppStore((state) => state.files)
  const activePath = useAppStore((state) => state.activeDocument?.path)
  const openFile = useAppStore((state) => state.openFile)
  const [query, setQuery] = useState('')
  const visible = useMemo(
    () => files.filter((path) => path.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 1_000),
    [files, query]
  )
  return (
    <section className="file-explorer">
      <div className="panel-label">Files</div>
      <label className="file-search">
        <Search size={13} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find file" />
      </label>
      <div className="file-list">
        {visible.map((path) => (
          <button
            key={path}
            className={`file-row ${activePath === path ? 'file-row--active' : ''}`}
            onClick={() => void openFile(path)}
            title={path}
          >
            <FileCode2 size={13} />
            <span>{path}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
