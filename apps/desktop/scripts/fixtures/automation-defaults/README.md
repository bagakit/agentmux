# Automation defaults slice

This fixture consumes current Core and client-ui source exports. It does not rebuild shared dist or qualify an installed Desktop.

The owning paths are SettingsPanel → AutomationDefaultsSettingsPane → original config save/CAS, Main scalar discovery → original Settings RPC/actual CLI → ConfigOwner/ConfigStore, and Composer → original Progress/Calendar controls → preload/registered IPC → original durable task owners. The Calendar leaf also has a real Mote sourced-message consumer. Preferences never enable a task; quiet follow-up still needs explicit opt-in. Same-target edits and unknown operations keep their original values and operation IDs; a completed task's next new form reads current defaults.

`continuous-progress-product.test.tsx` uses a private real Main Unix RPC server for calendar creation and the same Core future-intent owner. Native connection and I/O, Electron windows, Browser and connector startup are isolated; this proves neither a user's Run nor PTY throughput. Darwin uses a short private temporary root because its actual socket path must fit `sockaddr_un`. Background Notes initialization settles before this fixture removes its private root.

Run the finite source mutation verifier with the installed public Tracker script as an explicit test input (the existing Progress source-binding regression uses a private Tracker):

```sh
AGENTMUX_TEST_FEATURE_TRACKER_SCRIPT=/path/to/bagakit-feature-tracker/scripts/feature-tracker.sh \
  node apps/desktop/scripts/verify-automation-defaults.mjs --output .local/automation-defaults
```

The verifier records fresh assertion results and the owning source's loaded/compiled hashes. Setup errors, empty discovery and process failures do not qualify as semantic mutation reds. Full Renderer imagery, independent visual review and original-workspace process restart belong to the integrated Settings delivery oracle.
