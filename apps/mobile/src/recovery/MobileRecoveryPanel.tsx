import { MobileNotice } from '../notices/MobileNotice'
import { useEffect, useRef, useState } from 'react'
import { getDeviceWorkface, MAX_BACKUP_BYTES, type DeviceWorkface } from './device-workface'
import './recovery.css'

export function MobileRecoveryPanel({ onRestored = () => location.reload(), exportFile }: {
  onRestored?: () => void
  exportFile?: (filename: string, bytes: string) => Promise<void>
}) {
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeGeneration, setNoticeGeneration] = useState(0)
  const [candidate, setCandidate] = useState<DeviceWorkface | null>(null)
  const [exporting, setExporting] = useState(false)
  const epoch = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++epoch.current } }, [])
  const exported = async () => {
    if (exporting) return
    setNoticeGeneration(value => value + 1)
    setExporting(true)
    const active = ++epoch.current
    try {
      const bytes = getDeviceWorkface().exportBackup(), name = 'agentmux-workface.json'
      if (exportFile) await exportFile(name, bytes)
      else {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }))
        const link = document.createElement('a'); link.href = url; link.download = name
        document.body.appendChild(link); link.click(); link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 0)
      }
      if (active === epoch.current) setNotice('已交给系统保存。请确认文件已保留。文件包含草稿和输入记录，不含设备授权。')
    } catch { if (active === epoch.current) setNotice('工作面文件没有保存，可以重试。') }
    finally { if (mounted.current) setExporting(false) }
  }
  const inspect = async (file: File | undefined) => {
    const active = ++epoch.current
    setCandidate(null)
    if (!file) return
    setNoticeGeneration(value => value + 1)
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error('File is too large')
      const value = getDeviceWorkface().parseBackup(await file.text())
      if (active !== epoch.current) return
      setCandidate(value)
      setNotice('文件已完整核实，尚未替换当前工作面。恢复前请先导出需要保留的当前草稿。')
    } catch { if (active === epoch.current) setNotice('这个工作面文件无法读取，当前工作面没有被替换。') }
  }
  const restore = async () => {
    if (!candidate) return
    setNoticeGeneration(value => value + 1)
    try {
      await getDeviceWorkface().replaceBackup(candidate)
      setCandidate(null); setNotice('工作面已保存，正在重新读取。设备授权需另行确认，未知输入不会重投。')
      onRestored()
    } catch { setNotice('工作面没有恢复，当前工作面保持不变。请恢复设备存储后重试。') }
  }
  return <section className="mobile-workface-recovery" aria-labelledby="mobile-recovery-title">
    <h3 id="mobile-recovery-title">保留设备工作面</h3>
    <p>重装前保存导航、草稿与未确认输入。恢复后仍需核对 Mac 和设备授权。</p>
    <button className="mobile-secondary" disabled={exporting} onClick={() => { void exported() }}>
      {exporting ? '交给系统保存…' : '导出工作面文件'}
    </button>
    <button className="mobile-secondary mobile-workface-file" onClick={() => fileInput.current?.click()}>选择工作面文件</button>
    <input ref={fileInput} aria-label="选择已保留的工作面" hidden type="file" accept=".json,application/json" onChange={event => {
      void inspect(event.currentTarget.files?.[0]); event.currentTarget.value = ''
    }} />
    {candidate && <div className="mobile-workface-candidate">
      <p>{(candidate.host?.origin ?? candidate.hostUrl) || 'Mac 未记录'} · {candidate.conversation.drafts.length} 份草稿</p>
      <button className="mobile-secondary" onClick={restore}>恢复这份工作面</button>
      <button className="mobile-text-button" onClick={() => { ++epoch.current; setCandidate(null); setNotice(null) }}>保留当前工作面</button>
    </div>}
    {notice && <MobileNotice kind="feedback" identity={[noticeGeneration,notice]} role="status">{notice}</MobileNotice>}
  </section>
}
