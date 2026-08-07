import { GitPullRequestArrow, LoaderCircle, X } from 'lucide-react'
import type { FormEvent, ReactElement } from 'react'
import type { PrLaunchPlan } from '../lib/pr-launch'
import { ComposerTextarea } from './ComposerTextarea'

export type PrLaunchSurfaceProps = {
  /** The one plan from the one readiness read, or null when nothing has been asked for yet. */
  plan: PrLaunchPlan | null
  /** Set once a pull request really exists. Kept apart from `plan` so success is not a plan state. */
  createdUrl: string | null
  title: string
  body: string
  submitting: boolean
  onTitleChange: (value: string) => void
  onBodyChange: (value: string) => void
  onDismiss: () => void
  onSubmit: (event: FormEvent) => void
  onOpenCreated: (url: string) => void
}

/**
 * Everything the Source Control panel shows *after* a readiness read: the blocker list, the compose
 * form, and the "it exists now" receipt.
 *
 * Deliberately hookless, like {@link OpenDestinationBar}. Two reasons, and the second is the load-bearing
 * one:
 *
 *   - Layering: this region is a pure projection of one {@link PrLaunchPlan}. It decides nothing — which
 *     branch, which base, whether the ladder cleared, what gets submitted are all settled before the
 *     first prop arrives.
 *   - Observability: the desktop test project has no DOM, and `renderToStaticMarkup` renders a component's
 *     *initial* state only. Inline in ChangesPanel, every one of these branches sits behind a `useState`
 *     no test can reach, so the whole region could only ever be guarded by source-text assertions — and
 *     this codebase has repeatedly shipped bugs straight through those. As a plain function it can be
 *     called with each plan shape and its returned tree walked, so "the blockers render as copy" and
 *     "the guess is labelled as a guess" become real assertions.
 *
 * The shell still has to be wired: a component nobody renders is as silent as a branch nobody reaches,
 * which is why ChangesPanel's use of it is pinned separately.
 */
export function PrLaunchSurface({
  plan,
  createdUrl,
  title,
  body,
  submitting,
  onTitleChange,
  onBodyChange,
  onDismiss,
  onSubmit,
  onOpenCreated
}: PrLaunchSurfaceProps): ReactElement {
  return (
    <>
      {createdUrl ? (
        <div className="branches-inline-notice pr-created" role="status">
          <span>Pull request opened.</span>
          {/*
            The URL goes back out through the caller rather than a bare <a href>: the renderer has no
            external-navigation authority of its own, so a plain link either does nothing in this host or
            navigates the whole app away.
          */}
          <button type="button" className="small-button" onClick={() => onOpenCreated(createdUrl)}>
            View on GitHub
          </button>
        </div>
      ) : null}
      {plan?.kind === 'blocked' ? (
        <div className="pr-blockers" role="alert">
          <strong>Not ready to open a pull request</strong>
          {/*
            Every blocker at once, not just the first: fixing one, clicking again, and only then learning
            the next is a checklist turned into N round trips. This is also exactly why
            evaluatePrEligibility collects all of them instead of returning early.
          */}
          <ul>
            {plan.messages.map((line, index) => (
              <li key={plan.blockers[index] ?? line}>{line}</li>
            ))}
          </ul>
          <button type="button" className="small-button" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      ) : null}
      {plan?.kind === 'ready' ? (
        <form className="pr-form" onSubmit={onSubmit}>
          <header className="pr-form__header">
            <span>
              {plan.branch} → {plan.baseRef}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="Cancel pull request"
              onClick={onDismiss}
            >
              <X size={12} />
            </button>
          </header>
          {/*
            A guessed base has to say so. `origin/HEAD` does not exist in a repository that was created
            locally and pushed (this one included), so the fallback is the common case, not an edge. Shown
            as knowledge, the user never gets the chance to correct it — and a pull request opened against
            the wrong base is not undone by clicking again.
          */}
          {plan.baseSource === 'fallback' ? (
            <p className="pr-form__hint">
              The remote does not declare a default branch, so {plan.baseRef} is a guess. Check it before
              opening.
            </p>
          ) : null}
          <input
            className="pr-form__title"
            placeholder="Pull request title"
            value={title}
            spellCheck={false}
            disabled={submitting}
            onChange={(event) => onTitleChange(event.target.value)}
          />
          <ComposerTextarea
            className="pr-form__body"
            placeholder="Description (optional)"
            value={body}
            rows={3}
            disabled={submitting}
            onValueChange={onBodyChange}
          />
          <button
            type="submit"
            className="primary-button pr-form__submit"
            disabled={submitting || !title.trim()}
          >
            {submitting ? <LoaderCircle className="spin" size={12} /> : <GitPullRequestArrow size={13} />}
            {submitting ? 'Opening…' : 'Open pull request'}
          </button>
        </form>
      ) : null}
    </>
  )
}
