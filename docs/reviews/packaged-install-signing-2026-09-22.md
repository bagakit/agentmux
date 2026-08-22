# Packaged install signing review (2026-09-22)

## Accepted requirement

The canonical macOS install must only be replaced after the current clean source has
produced a signed, strictly verifiable, identity-bearing bundle that launches. If
candidate signing fails, the previous installation remains active and the failure
stage is reported. The three global surface controls remain a single bottom-centered
switch; the top-right chrome has no duplicate Agents/Session/Board navigation.

## Observations and bounded change

The Electron download carries macOS provenance extended attributes. The first
package attempt failed while signing `Electron Framework.framework`. A test copy
with extended attributes cleared passed signing, as did the second package attempt.
This is correlation, not an isolated proof of cause: the disk subsequently exhausted
its free space while extracting the DMG verification copy. Clearing attributes on
the staged candidate does not alter runtime contents or canonical cutover ordering.

The second attempt failed with `No space left on device` before installation.
The installed identity remains `c5308881`; candidate commit `3d29b104` is not installed.
The script removed its failed staging directory; this turn's signing test copy was
also removed. Free space afterward was approximately 1.1 GiB. Installation remains
blocked until sufficient staging space is available. The four targeted test files
passed (13 tests); removing the candidate attribute-clear call made the contract
test fail. No successful installation or restart verification is claimed.

## Verification boundary

- `xattr -cr` runs on the staged candidate before the first signature operation.
- The existing package identity, strict signature, DMG, LaunchServices, and restart
  checks remain the gates.
- A failed gate leaves the installed AgentMux.app untouched.
