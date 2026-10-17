/** Only the original Window's trusted native event supplies a Renderer event clock. */
export function trustedRendererEventTimestamp(event: Pick<MouseEvent, 'isTrusted' | 'view' | 'timeStamp'>, view: Window): number | null {
  return event.isTrusted && event.view === view ? event.timeStamp : null
}
