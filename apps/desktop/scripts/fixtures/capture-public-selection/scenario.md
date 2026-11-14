# Public native selection verification

## Purpose

Prove the existing public `native.capture` region-selection contract through the real product chain, without adding a command, wire field, picker or second capture owner.

## Executed chain

1. Build and invoke the actual `amux native capture --data` CLI against a Unix `AgentMuxControlServer`.
2. Evaluate the exact `nativeDesktop` adapter slice from production `ipc.ts`, which delegates to `createNativeDesktopPublicOwner` and the same `CaptureSurface` as the GUI.
3. Drive the production capture preload and Renderer with trusted CDP input through two consecutive `captured` results, a cancellation and a native excluded-source failure.
4. Check duplicate-operation and completed-operation inspection replies without another capture.

The second `captured` request must have no `initialCrop`, must focus the display under the pointer rather than the previous crop display, and returns only its new selection. The unavailable excluded source must return its typed `failed` result and original error code instead of offering included pixels.

## Production counterexamples

The verifier runs the same Electron/CLI scene against two exact source mutations:

- restore process-level cross-request selection recall; the second public capture must reject it;
- remove the exact-background failure guard; the excluded-unavailable scene must reject an included fallback.

A timeout, collection/build failure, external termination or empty scene is not a mutation kill. Receipts bind all build inputs, the production adapter and consumed mutation source by SHA-256.

## Boundary

Native display pixels and geometry are controlled. This is not physical multi-monitor, OS screen-recording permission, installation, packaging, macOS-version or aesthetic proof. Those remain with their owning live verification.
