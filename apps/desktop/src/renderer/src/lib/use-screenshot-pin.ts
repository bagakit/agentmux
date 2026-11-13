import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { mintObjectId } from '@agentmux/core/object-id'
import type { ImageResult } from '@agentmux/core'
import type { BrowserPng } from '../../../shared/contracts'
import type { ScreenshotPngExport } from '../../../shared/screenshot-output'

class UnconfirmedPin extends Error {}

/** Lost readers retain only their operation IDs; explicit new pins keep their own effects. */
export function useScreenshotPin(ports: {
  pin(input: ScreenshotPngExport): Promise<ImageResult>
  inspect(operationId: string): Promise<ImageResult>
}) {
  const operations = useRef(new Set<string>()), checking = useRef(false), alive = useRef(true)
  const [uncertain, setUncertain] = useState(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  function markUncertain(value: boolean) { if (alive.current) setUncertain(value) }
  function unconfirmed(id: string, cause?: unknown) {
    return new UnconfirmedPin(`Pin creation is unconfirmed (operation ${id}). Check pin cycles through unconfirmed original operations. Pin another creates a separate reference.${cause ? ' ' + presentError(cause) : ''}`)
  }
  function observe(id: string, result: ImageResult): ImageResult {
    const record = result.recordedOperation
    if (record?.operationId === id && record.method === 'image.pin' && (record.state === 'completed' || record.state === 'failed')) {
      operations.current.delete(id); markUncertain(operations.current.size > 0)
      return result
    }
    markUncertain(true)
    throw unconfirmed(id)
  }
  async function pin(image: BrowserPng): Promise<ImageResult> {
    const id = mintObjectId()
    operations.current.add(id)
    try { return observe(id, await ports.pin({ operationId: id, image })) }
    catch (cause) { if (cause instanceof UnconfirmedPin) throw cause; if (operations.current.has(id)) { markUncertain(true); throw unconfirmed(id, cause) }; throw cause }
  }
  async function checkPin(): Promise<ImageResult | null> {
    const id = operations.current.values().next().value
    if (!id || checking.current) return null
    checking.current = true
    operations.current.delete(id)
    operations.current.add(id)
    try { return observe(id, await ports.inspect(id)) }
    catch (cause) { if (cause instanceof UnconfirmedPin) throw cause; if (operations.current.has(id)) { markUncertain(true); throw unconfirmed(id, cause) }; throw cause }
    finally { checking.current = false }
  }
  return { pin, checkPin, uncertain }
}
