# Browser start-page refresh — real Renderer probe

Owning behavior: `docs/design/behavior/browser-workface.md#browser-空白起始页`.
Owning presentation: `docs/design/presentation/browser-workface.md#browser-空白起始页`.

The probe mounts the actual App → GlobalSurveySurface → Workbench → BrowserPane → BrowserStartPage and complete application source CSS. It seeds 18 explicit fixture inputs in one original Workspace/Profile with five real Renderer Browser Regions. Four retained preview image payloads are captured by this invocation's isolated Electron process from its own local HTTP documents, with the exact source URL and timestamp retained in the receipt. This does not certify production Main input-history persistence or preview-store capture/durability.

Native CDP pointer, text and Enter events exercise the toolbar and central draft, their original shared submission consumer, Show all / Show less, and a history-card click. The original Browser/Profile/Workspace are checked throughout; no user Session, Runtime, native page or installed application is controlled. The fixture's existing unrelated Agent state and unsent draft are retained.

Captures: normal dark at 1440×950, large dark at 1920×1080, central and toolbar focus with shared drafts, expanded 18-item history, narrow App at 740×860 (approximately 480px Browser Region beside the actual Survey sidebar), a native wheel scroll to the narrow history end and back, narrow focus, normal light, and an actual image-decoding failure followed by original history navigation. A failed image is introduced by corrupting the rendered image source; the actual component's error handler must recover to its normal cover.

Capture success is behavior evidence only. An independent Agent must open the full PNGs and assess hierarchy, whitespace, responsive reading, precise targets, and fallback aesthetics before visual delivery.
