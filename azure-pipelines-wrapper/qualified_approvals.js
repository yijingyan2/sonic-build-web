const { Octokit } = require("@octokit/rest");
const { parseMapping, coverage, qualifiedApprovalLabel } = require("./qualified_approval_coverage");
const akv = require("./keyvault");
const actionQueue = require("./action_queue");
const { loadCodeowners } = require("./codeowners");
const { planAssignments } = require("./reviewer_assignment");
const { loadReviewerAccess } = require("./reviewer_access");

const repos = new Set(["sonic-net/sonic-mgmt"]);
const mappingRepo = { owner: "sonic-net", repo: "sonic-tsc", ref: "master" };

async function sync(octokit, owner, repo, number, assign = false, log = console, comment = !assign) {
    const params = { owner, repo, pull_number: number };
    const { data: pr } = await octokit.rest.pulls.get(params);
    if (pr.state !== "open") {
        return;
    }
    const mappingPath = `pr_reviewer/${repo}/pr_reviewer-by-files.yml`;
    const [{ data: source }, files, reviews, codeowners] = await Promise.all([
        octokit.rest.repos.getContent({ ...mappingRepo, path: mappingPath }),
        octokit.paginate(octokit.rest.pulls.listFiles, { ...params, per_page: 100 }),
        octokit.paginate(octokit.rest.pulls.listReviews, { ...params, per_page: 100 }),
        loadCodeowners(octokit, owner, repo, pr.base.sha),
    ]);
    if (source.type !== "file" || source.encoding !== "base64" || !source.content) {
        throw new Error(`Reviewer mapping is not a readable file: ${mappingPath}`);
    }
    const mapping = parseMapping(Buffer.from(source.content, "base64").toString("utf8"));
    const mappingLink = `https://github.com/${mappingRepo.owner}/${mappingRepo.repo}/blob/${mappingRepo.ref}/${mappingPath}`;
    const result = coverage(files, mapping, reviews, pr, mappingLink, codeowners);
    async function freshPull() {
        const { data: current } = await octokit.rest.pulls.get(params);
        if (current.state !== "open" || current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha) {
            throw new Error("PR changed while calculating qualified approval coverage; skipping stale summary");
        }
        return current;
    }
    let current = await freshPull();
    if (comment && result.body.length > 60000) {
        throw new Error("Qualified approval summary exceeds the comment size limit");
    }
    const label = (current.labels || []).find(item => item.name.toLowerCase() === qualifiedApprovalLabel.toLowerCase());
    const issue = { owner, repo, issue_number: number };
    if (result.qualified && !label) {
        await octokit.rest.issues.addLabels({ ...issue, labels: [qualifiedApprovalLabel] });
        log.info(`[ QUALIFIED APPROVAL ] ${owner}/${repo}#${number}: added ${qualifiedApprovalLabel}`);
    } else if (!result.qualified && label) {
        await octokit.rest.issues.removeLabel({ ...issue, name: label.name });
        log.info(`[ QUALIFIED APPROVAL ] ${owner}/${repo}#${number}: removed ${qualifiedApprovalLabel}`);
    }
    let plan = null;
    if (assign && !current.draft) {
        const access = await loadReviewerAccess(octokit, owner, repo, codeowners, log);
        current = await freshPull();
        if (!current.draft) {
            plan = planAssignments(files, mapping, reviews, current, codeowners, Math.random, access);
        }
    }
    if (plan) {
        const label = `${owner}/${repo}#${number}`;
        if (plan.excluded.length) {
            log.warn(`[ REVIEWER ASSIGNMENT ] ${label}: excluded non-collaborators: ${plan.excluded.join(", ")}`);
        }
        log.info(`[ REVIEWER ASSIGNMENT ] ${label}: reviewers=${JSON.stringify(plan.reviewers)}, teams=${JSON.stringify(plan.team_reviewers)}, total=${plan.requestedTotal}`);
        if (plan.reviewers.length || plan.team_reviewers.length) {
            await octokit.rest.pulls.requestReviewers({
                ...params, reviewers: plan.reviewers, team_reviewers: plan.team_reviewers,
            });
            log.info(`[ REVIEWER ASSIGNMENT ] ${label}: review requests accepted`);
        } else {
            log.info(`[ REVIEWER ASSIGNMENT ] ${label}: no new review requests needed or eligible`);
        }
        if (plan.rows.length && plan.requestedTotal < 3) {
            log.warn(`[ REVIEWER ASSIGNMENT ] ${label}: fewer than three eligible review requests available`);
        }
    }
    if (!comment) {
        return;
    }
    await octokit.rest.issues.createComment({ ...issue, body: result.body });
}

function init(app) {
    app.on([
        "pull_request_review.submitted",
        "pull_request_review.dismissed",
        "pull_request.opened", "pull_request.reopened", "pull_request.synchronize",
        "pull_request.edited",
        "pull_request.ready_for_review",
    ], async context => {
        const { repository, pull_request: pr, action, changes, review } = context.payload;
        const assign = ["opened", "reopened", "ready_for_review", "synchronize"].includes(action) ||
            (action === "edited" && Boolean(changes && changes.base));
        const approval = action === "submitted" && review && review.state.toUpperCase() === "APPROVED";
        const lostApproval = action === "dismissed" ||
            (action === "submitted" && review && review.state.toUpperCase() === "CHANGES_REQUESTED");
        if (!repos.has(repository.full_name) || pr.state !== "open" ||
            (!assign && !approval && !lostApproval)) {
            return;
        }
        return actionQueue.enqueueAction(async () => {
            const token = await akv.getGithubToken();
            await sync(new Octokit({ auth: token }), repository.owner.login, repository.name, pr.number, assign, app.log, approval);
        }, `qualified approvals ${repository.full_name}#${pr.number}`, app);
    });
}

module.exports = Object.freeze({ init, sync });
