# event-collector

> A GitHub App built with [Probot](https://github.com/probot/probot) that Event Collector

## Setup

```sh
# Install dependencies
npm install

# Run the bot
npm start
```

## Docker

```sh
# 1. Build container
docker build -t event-collector .

# 2. Start container
docker run -e APP_ID=<app-id> -e PRIVATE_KEY=<pem-value> event-collector
```

## Qualified approval coverage

For the `sonic-net/sonic-mgmt` pilot, the bot posts informational PR
comments showing which changed folders have qualified approval, which are awaiting
approval, and which have no reviewer mapping. It does not block merging.

Reviewer membership comes from
[`sonic-net/sonic-tsc` on `master`](https://github.com/sonic-net/sonic-tsc/blob/master/pr_reviewer/sonic-mgmt/pr_reviewer-by-files.yml),
never from the PR branch. For each folder, add the mapped scores of distinct users
with active approvals for the current PR head. The folder qualifies only when
that sum is **at least 0.4**; exactly 0.4 qualifies. Multiple
approvers can combine their scores, but repeated reviews by the same user do not
add extra weight. Unmapped users contribute nothing. The comment shows the total
approval score for each folder. Scores are not pooled across different folders.
The most specific mapped folder wins,
with nearest-parent fallback only when there is no mapping for that folder. An
empty reviewer entry does not inherit its parent's reviewers.

Alternatively, a changed file qualifies when an active current-head approval is
from a matching `.github/CODEOWNERS` user or team member. Rules are case-sensitive,
the last matching rule wins, and an ownerless rule clears earlier owners.
CODEOWNERS approval does not need a score of 0.4. This is evaluated per file:
a folder is marked approved only when every changed path in it qualifies by
score or CODEOWNERS; renames still require both paths. The table lists approving
code owners, including team names when applicable.
The comment footer links both the reviewer mapping and the CODEOWNERS file used
for evaluation. If CODEOWNERS is missing, it says that the file is not available.

The bot reads CODEOWNERS at the PR's trusted **base commit**, not its head.
A missing file (404) is allowed and leaves score-based behavior unchanged.
Other read failures and team membership failures are errors, not assumed approval.
Team resolution needs organization members read permission on the bot token.
Supported patterns include anchored paths, directories, `*`, `**`, and `?`.
Unsupported syntax (including email owners, negation, character classes, and
escaped paths) is reported explicitly rather than guessed.

Only each user's latest decisive review counts (`APPROVED`, `CHANGES_REQUESTED`,
or `DISMISSED`); a comment-only review does not replace an approval. Approvals
must match the current head commit. PR-author and bot approvals are excluded.
Different qualified users can cover different folders. Renamed files require
coverage of both old and new paths, but count only once in the overall file total.
The table shows up to 100 folders; totals always include all changed files.
Mapping/API failures and incomplete file lists are logged through the action queue
instead of producing a misleading coverage result.

The coverage summary is posted as a **new comment only when a new approval review is
submitted**. Comment-only reviews, changes requested, dismissals, PR lifecycle
events, and new commits do not publish or update comments. Consequently, the
summary is a snapshot as of the latest processed approval, not a continuously
refreshed status. Previous comments are never edited, and each processed approval
posts a new snapshot even if its coverage is identical to an earlier one.
Comments use the existing `mssonicbld` token.

When every changed path in every folder has qualified approval, the bot adds
`Qualified-approval`. The fresh coverage comment on a new approval announces that
all folders qualify and explains that this meets the qualified-approval requirement
for auto-merge. Partial coverage (including a rename with only one qualified path)
or an empty changed-file list does not qualify.

The label is kept current on PR lifecycle events listed below, base-branch changes,
submitted approvals or changes-requested reviews, and dismissed reviews. If coverage
is lost, the bot removes the label without posting another comment. Comment-only
reviews do not replace approvals or trigger recalculation. Existing matching labels
are not re-added; unrelated labels are never changed. Label API failures are reported
through the action queue. Reviewer assignment lookup failures do not prevent an
already-calculated label update.

The label certifies approval coverage, **not all merge conditions**: required CI,
branch protection, draft state, and mergeability still apply. The wrapper does not
enable GitHub auto-merge or merge PRs. Lifecycle/dismissal updates do not edit old
coverage comments; consult the current label for the latest evaluated status.
Mapping and CODEOWNERS changes outside these PR events are not polled.

Deployment: enable **Pull request review** webhook events in the existing GitHub
App settings (changing `app.yml` alone does not update an installed app). The bot
token needs read access to the trusted mapping repository and PR files/reviews,
and write access to PR issue comments and labels. Publish the reviewer mapping at the trusted
upstream path above before deployment; a local copy or a copy in a fork is not used.
Additional repositories must be explicitly
added to the pilot allowlist after their mappings are available.

### Automatic reviewer assignment

For the sonic-mgmt pilot, non-draft open PRs receive reviewer requests on opening,
reopening, becoming ready for review, new commits, and base-branch changes.
Already-qualified paths need no additional requests. For each remaining path:

1. Prefer one eligible owner from the last matching CODEOWNERS rule. Request team
   owners as teams, not as individual members. Teams with no non-author human
   members are not eligible.
2. If no eligible code owner exists, select one reviewer with an individual score
   **at least 0.4** from the most-specific reviewer mapping. The approval policy
   still allows combined scores; assignment does not pick users below 0.4.
3. Reuse an existing matching request, then an already-selected reviewer; otherwise
   choose randomly among candidates. Deduplicate requests across paths. Never
   remove existing reviewer requests or reshuffle a still-outstanding request.

After covering unqualified paths, top up to **at least three outstanding review
requests**, counting each distinct user or team as one. Existing requests count
toward that total. Prefer additional CODEOWNERS, then mapped users with individual
scores at least 0.4 from the remaining unqualified changed paths. Request only
eligible candidates; if fewer than three exist, request those available. Do not
recruit unrelated or below-threshold reviewers, or add requests for paths that
already have qualified approval. Covering all paths may require more than three
requests; three is a minimum target, not a cap. The local preview reports the
planned request total and any candidate shortage.

Auto-assignment is silent: it neither creates nor updates PR comments.
Before selecting candidates, the bot paginates repository collaborators and
checks repository access for referenced CODEOWNERS teams. Non-collaborators and
teams without access to the repository are excluded (including from minimum-three
top-ups); inaccessible owners can fall back to eligible mapped users. Bot users
are excluded from the collaborator list. Eligibility lookup failures other than
a team's 404 are surfaced, not treated as an empty success.
Selection logs use `[ REVIEWER ASSIGNMENT ]` and include excluded users, selected
user/team names, the planned total, and confirmation after GitHub accepts the
request. If GitHub rejects the request (for example after access changes), the
action queue reports the failure and the selected names remain visible in logs.
The author and bot accounts are excluded. Paths without candidates are left
unassigned instead of choosing below-threshold reviewers; the local preview
identifies those paths. Renames consider
both paths. API failures (including invalid/unrequestable owners) propagate through
the action queue; the bot does not silently substitute unrelated reviewers.
This does not change the most-specific-folder inheritance policy.

Deployment also requires **Pull requests: write** on the installed GitHub App
and bot token. Updating the manifest alone does not grant those permissions.

### Local read-only report

Use the local `sonic-tsc` mapping to preview coverage for recently approved **open
and merged** `sonic-net/sonic-mgmt` PRs without publishing any comments:

```sh
cd azure-pipelines-wrapper
gh auth login
bash qualified_approvals_report.sh --days 7 --limit 10 \
  --report /tmp/sonic-mgmt-qualified-approvals.md
```

Requires Bash, Python 3 with PyYAML, and an authenticated GitHub CLI on `PATH`.
Node.js, npm dependencies, and Azure credentials are not needed for this script.
If PyYAML is missing, install your system's `python3-yaml` package, or activate a
Python virtual environment and run `python3 -m pip install PyYAML`.
By default, the mapping is resolved relative to the script at
`../../sonic-tsc/pr_reviewer/sonic-mgmt/pr_reviewer-by-files.yml`, matching sibling
`public/sonic-build-web` and `public/sonic-tsc` checkouts. Override it if needed:

```sh
bash qualified_approvals_report.sh --days 30 --limit 20 \
  --mapping /path/to/sonic-tsc/pr_reviewer/sonic-mgmt/pr_reviewer-by-files.yml \
  --codeowners /path/to/sonic-mgmt/.github/CODEOWNERS \
  --report /path/to/local-report.md
```

The script uses the authenticated `gh` account and only makes GitHub GET requests;
it does not load Azure credentials or use the bot token. It appends a dated run
header and one generated comment per PR to the report, preserving previous runs.
No output-directory creation is attempted: the report's parent must already exist.
The local report defaults to the sibling `sonic-mgmt/.github/CODEOWNERS` file,
so unpublished ownership changes can be tested. Missing local CODEOWNERS is
reported on stderr and is allowed. Team membership is read from GitHub using
the authenticated CLI account, which must be allowed to read the referenced teams.
It also includes a reviewer-assignment preview for open, non-draft PRs, using the
same selection policy. Random choices may differ between runs. Merged and draft
PRs skip assignment previews. No review requests are sent by the local script.
Assignment previews also check collaborators and team repository access using
the CLI account. That account needs permission to list repository collaborators;
lookup failures stop the report instead of suggesting unvalidated reviewers.

Candidates are ordered by PR update time and must have a non-dismissed approval
submitted within the last `--days` days; the approval timestamp is checked rather
than assuming every recently updated PR was recently approved. Closed, unmerged
PRs are excluded. Search stops at `--limit` matching PRs or when results are
exhausted. GitHub's 1000-candidate search cap is surfaced as an error when reached;
narrow the time window in that case.

The standalone script implements the bot's mapping and coverage rules in Python
so it can run without Node.js.
Coverage still requires an active approval for the current PR head, so a PR with
newer commits can appear in the report with no coverage. Merged PRs use their
retained PR head, not the merge commit; the report tests today's local mapping,
not the mapping or policy that existed when they merged. Failures are written
to the report and exit nonzero; incomplete data is not reported as coverage.
Run `bash qualified_approvals_report.sh --help` for options.
Run its tests with `python3 -m unittest discover -s test -p 'test_qualified_approvals_report.py'`.

## Contributing

If you have suggestions for how event-collector could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2021 Xuhui Miao <xumia@microsoft.com>
