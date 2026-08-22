# Packaged install signing review (2026-09-22)

## Accepted requirement

The canonical macOS install must only be replaced after the current clean source has
produced a signed, strictly verifiable, identity-bearing bundle that launches. If
candidate signing fails, the previous installation remains active and the failure
stage is reported. The three global surface controls remain a single bottom-centered
switch; the top-right chrome has no duplicate Agents/Session/Board navigation.

## Root cause and bounded fix

The Electron download carries macOS provenance extended attributes. Copying that
bundle with `cp -cR` preserved them, and the ad-hoc signer failed while replacing the
signature on `Electron Framework.framework`. Clearing extended attributes on the
staged candidate before branding/signing is the smallest fix; it does not alter the
runtime contents or the canonical cutover safety ordering.

## Verification boundary

- `xattr -cr` runs on the staged candidate before the first signature operation.
- The existing package identity, strict signature, DMG, LaunchServices, and restart
  checks remain the gates.
- A failed gate leaves the installed AgentMux.app untouched.
