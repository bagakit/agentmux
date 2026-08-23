# Packaged install success (2026-09-22)

The clean `f31f12824da58a4ff275e7fff1765e35650e77ed` snapshot was packaged from an
isolated worktree and installed over the existing AgentMux.app. The package identity recorded in the bundle is:

- source commit: `f31f12824da58a4ff275e7fff1765e35650e77ed`
- source tree: `4cff71d73e50be7ea42c41751145c1a877b4f0e4`
- app executable SHA-256: `0daeecb7b710697a53b333b857775d7b133d52a5fd91fad8f74a7e837e452af1`
- DMG SHA-256: `3b2211a3cf8ea698bfa5413acfdb30a3c3f73247b893059d7464810f96c88318`

The candidate passed strict code-signature verification, DMG mount and desktop
interaction checks, workspace move helper checks, and the embedded ctxmux smoke
checks. The installer gracefully quit the previous instance, moved it to Trash,
atomically replaced the canonical app, and relaunched the new bundle as PID
`61152`. The post-install report confirmed `canonicalMatchesCandidate=true`,
`canonicalMatchesCheckout=true`, `runningCanonical=true`, and
`mismatchCount=0`.

The installed and candidate ctxmux trees had the same hash, so no runtime
cutover review was required. This is an ad-hoc local candidate and is not
notarized. Parallel uncommitted edits that appeared in the main worktree while
packaging were left untouched and are not included in this installed snapshot.
