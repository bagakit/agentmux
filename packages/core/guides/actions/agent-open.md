# agent-open

<!-- amux:content -->
Agent-first workflow:
1. Inspect Project resources and the intended Space separately with app snapshot and space inspect.
2. Choose a split or a new Tab from the advisory playbook. For a new Tab in an existing Zone,
   use agent open --zone ZONE --new-tab --executor EXECUTOR --prompt TASK.
3. To create a Zone, supply --project PROJECT --space SPACE --new-zone and either
   --worktree --path PATH --new-branch BRANCH or --directory PATH. If a Project's source
   is ambiguous, inspect its real Workspaces and explicitly pass --source-workspace WORKSPACE.
4. Retain the exact business operation ID, returned SID/Run and spatial address.
5. Use agent inspect, agent output and agent send for follow-up. Delivery is not completed work.
6. After a lost Agent creation/move reply, read space inspect --operation-id ID;
   for File open, retain the original resource and inspect its actual Regions as above.
   An unknown original operation stays unconfirmed; do not blindly repeat.

For an original Mote Main start, agent open --input may carry its typed moteMain intent.
Keep the exact target, original MOTE baseline/role and operation IDs. A frozen deferredInput
is the person's first Query; handover:true adds context from that original previous Main.
Creation remains no-input. Only after the original setup confirms binding does explicit
space mote dialogue setup advance submit those retained intents through Core Main input.
Inspect is read-only; a route alone does not prove sending. Keep the canonical original
input key and unknown outcome across navigation or restart; never start another Agent or
mint another Query to repair an observation. Use amux mote --skill for the complete contract.

space mv moves a presentation and leaves the original execution cwd/Host/Session/Run intact.
Default Agent/File opens and presentation changes keep background navigation and eligible input.
app focus selects a Surface, or --surface focus --host HOST --session SID reveals an exact
original Agent in Focus list without changing the filters or transferring input. Inspect
focus.agent for actual card visibility. space focus and goal focus navigate exact objects. Selection,
presentation and actual caret eligibility are separate facts. Never stop a healthy Run to repair
an observation or handshake. Reader cancellation only detaches that reader.

[Remote execution from a project](remote-execution.md "amux:include")
