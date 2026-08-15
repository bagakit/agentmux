import type { AppConfig, FanOutLaneOutcome, WorktreeRetention } from '../shared/contracts'
import type { FanOutBranch } from './fanout-plan'
import { classifyRetention } from './worktree-service.js'

// Running one prompt down N lanes.
//
// The happy path here is trivial: a loop. The reason this module exists is the unhappy path. Halfway
// through creating five worktrees and launching five agents, lane three can fail — and then the caller
// needs to know which lanes are live, which never started, and what lane three left on disk. Throwing
// on first failure would abandon the lanes that already succeeded with no record of them; resolving
// with a bare boolean would lose the same information more quietly.
//
// So a fan-out returns per-lane outcomes and never throws for a lane's sake. The orchestration lives in
// Desktop main because Core deliberately does not own a coordinator loop; this only sequences public
// calls that already exist (worktree creation, single-input agent launch).

/**
 * One lane's fate. The contract's own type, not a second copy of it.
 *
 * It used to be declared here and again in `contracts.ts`, identical by hand. Two declarations of one
 * shape drift the moment either side gains a field — and this one did: separating the three retention
 * states had to be done twice, in two files, with nothing forcing the second. Aliasing means the IPC
 * boundary and the orchestrator cannot disagree about what a lane says.
 */
export type FanOutLaneResult = FanOutLaneOutcome

export type FanOutResult = {
  lanes: FanOutLaneResult[]
}

export type FanOutPorts = {
  /** Create a worktree on a new branch off HEAD, registering it as a workspace. */
  createWorktree(input: {
    workspaceId: string
    branch: string
    path: string
    createBranch: true
  }, config: AppConfig): Promise<{ config: AppConfig; workspace: { id: string; path: string } }>
  /** Launch one agent in an existing workspace. Single input — there is no batch primitive in Core. */
  launchAgent(input: {
    executorId: string
    workspacePath: string
    prompt: string
  }, config: AppConfig): Promise<{ sessionId: string }>
  /**
   * Undo a lane's worktree. Optional: when absent, a lane that creates a worktree but fails to launch
   * keeps it and says so, which is strictly better than pretending it was cleaned up.
   */
  removeWorktree?(
    input: { workspaceId: string },
    config: AppConfig
  ): Promise<{ config: AppConfig }>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run the fan-out.
 *
 * Lanes are sequential on purpose. They all touch the same git repository — concurrent
 * `git worktree add` calls contend on the same index and metadata — and the config is threaded through
 * each registration, so parallel lanes would race on both. The agents themselves run concurrently once
 * launched, which is where the actual parallelism the user wants lives.
 *
 * One lane's failure never stops the others: the point of a bake-off is the lanes that DID work.
 *
 * ## Why each lane re-reads the config instead of threading one copy through
 *
 * A fan-out is a LONG operation: every lane runs `git worktree add` and then starts an agent, so the
 * whole request spans seconds to tens of seconds. The main process keeps serving other IPC the entire
 * time — removing a worktree, opening a project, changing a setting — and each of those does its own
 * read-modify-write on the single mutable `config` in `registerIpc`.
 *
 * This used to take one snapshot at the start and hand the accumulated result back at the end, where the
 * caller assigned it wholesale. Everything written by anyone else in between was silently overwritten:
 * the record came back while the directory was already gone. Reproduced, not theorised — see
 * `fanout-config-lost-update.test.ts`, which interleaves one write after the first lane and was red
 * before this change.
 *
 * `readConfig()` is the same live accessor the handler exposes, so each lane starts from what is
 * actually current. The remaining window is one lane's own create-then-save, which is the same shape
 * every other handler already has; closing it completely needs a single-writer config with a version
 * check, which is a separate change and not one to smuggle in here.
 */
export async function runFanOut(input: {
  workspaceId: string
  prompt: string
  lanes: readonly FanOutBranch[]
  /** The live config accessor — called once per lane, never cached across an await. */
  readConfig: () => AppConfig
  /** Publish one lane's registration immediately, so the next reader sees it. */
  commitConfig: (config: AppConfig) => void
  ports: FanOutPorts
}): Promise<FanOutResult> {
  const results: FanOutLaneResult[] = []

  for (const lane of input.lanes) {
    let created: { config: AppConfig; workspace: { id: string; path: string } }
    try {
      created = await input.ports.createWorktree(
        { workspaceId: input.workspaceId, branch: lane.branch, path: lane.path, createBranch: true },
        input.readConfig()
      )
    } catch (error) {
      // Nothing was created, so nothing is stranded. Record and move to the next lane.
      results.push({
        status: 'worktree-failed',
        branch: lane.branch,
        path: lane.path,
        error: message(error)
      })
      continue
    }
    // Published per lane rather than accumulated: a later lane that throws must not take the earlier
    // lanes' registrations down with it, and any other handler that runs between two lanes has to see
    // the worktrees that already exist on disk.
    input.commitConfig(created.config)

    try {
      const launched = await input.ports.launchAgent(
        { executorId: lane.executorId, workspacePath: created.workspace.path, prompt: input.prompt },
        input.readConfig()
      )
      results.push({
        status: 'launched',
        branch: lane.branch,
        path: created.workspace.path,
        sessionId: launched.sessionId
      })
    } catch (error) {
      // A worktree with no agent. Try to hand it back, but a cleanup failure must not overwrite the
      // launch failure that caused it — the user needs the original reason, plus the truth about what is
      // still on disk.
      //
      // "What is still on disk" is a three-way answer, not a boolean. This arm used to record
      // `retained = true` in the catch, which asserted the directory survived — true for a git failure
      // and for the dirty-tree refusal, and FALSE for the third case, where git deleted the directory
      // and only the record write failed. Guessing from a catch cannot tell those apart, so the
      // classification comes from where the failure happened, through the one shared classifier.
      let cleanup: { retention: WorktreeRetention; reason: string } | null = {
        retention: 'git-failed',
        // No teardown port at all: nothing was attempted, so nothing was discarded and the directory
        // stands. That is what `git-failed` promises, and it offers no discard button — correct here,
        // because there is no failure of git's to report either.
        reason: 'No worktree teardown is wired, so the lane kept its checkout.'
      }
      if (input.ports.removeWorktree) {
        try {
          const cleaned = await input.ports.removeWorktree(
            { workspaceId: created.workspace.id },
            input.readConfig()
          )
          input.commitConfig(cleaned.config)
          cleanup = null
        } catch (cleanupError) {
          cleanup = classifyRetention(cleanupError)
        }
      }
      results.push({
        status: 'launch-failed',
        branch: lane.branch,
        path: created.workspace.path,
        error: message(error),
        cleanup
      })
    }
  }

  return { lanes: results }
}

/**
 * Whether a fan-out produced anything worth comparing.
 *
 * Used to tell "some lanes are running" from "nothing came up", so a caller does not present an empty
 * bake-off as a successful one.
 */
export function launchedLanes(result: FanOutResult): Extract<FanOutLaneResult, { status: 'launched' }>[] {
  return result.lanes.filter(
    (lane): lane is Extract<FanOutLaneResult, { status: 'launched' }> => lane.status === 'launched'
  )
}

/**
 * Lanes that left a worktree behind with no agent in it.
 *
 * Surfaced separately because this is the state a person has to decide about: the directory is real, it
 * holds no running work, and only they know whether to retry or discard it.
 *
 * `record-not-withdrawn` is deliberately NOT stranded: there the directory is gone and only the record
 * survives, so there is no checkout to retry or discard — offering one would point the user at a path
 * that does not exist. It still needs saying, and the renderer's per-retention notices say it; it is
 * just not this list's subject.
 */
export function strandedLanes(result: FanOutResult): Extract<FanOutLaneResult, { status: 'launch-failed' }>[] {
  return result.lanes.filter(
    (lane): lane is Extract<FanOutLaneResult, { status: 'launch-failed' }> =>
      lane.status === 'launch-failed' &&
      lane.cleanup !== null &&
      lane.cleanup.retention !== 'record-not-withdrawn'
  )
}
