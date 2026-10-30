const { ownersForFile, approvedOwners } = require("./codeowners");
const { mappedFolder, currentApprovers, approvalScore, escapeCell } = require("./qualified_approval_coverage");

function planAssignments(files, mapping, reviews, pr, codeowners, random = Math.random, access = null) {
    if (files.length !== pr.changed_files) throw new Error("Incomplete changed-file list for reviewer assignment");
    const approvers = currentApprovers(reviews, pr);
    const author = pr.user.login.toLowerCase();
    const requested = new Set([
        ...(pr.requested_reviewers || []).map(user => user.login.toLowerCase()),
    ]);
    const requestedTeams = new Set((pr.requested_teams || []).map(team => team.slug.toLowerCase()));
    const selected = new Set();
    const additional = new Map();
    const excluded = new Set();
    const hasUserAccess = login => {
        const allowed = !access || access.users.has(login.toLowerCase());
        if (!allowed) excluded.add(login.toLowerCase());
        return allowed;
    };
    const eligibleUser = login => login.toLowerCase() !== author &&
        login.toLowerCase() !== "mssonicbld" && !login.toLowerCase().endsWith("[bot]") && hasUserAccess(login);
    const rows = [];
    for (const file of files) {
        const paths = [file.filename];
        if (file.status === "renamed") {
            if (!file.previous_filename) throw new Error("Missing previous filename for reviewer assignment");
            paths.push(file.previous_filename);
        }
        for (const filename of new Set(paths)) {
            const folder = mappedFolder(filename, mapping);
            const entries = folder === null ? [] : Object.entries(mapping[folder]);
            const score = approvalScore(entries.filter(([login]) => approvers.has(login.toLowerCase())).map(([, value]) => value));
            if (score >= 0.4 || approvedOwners(filename, codeowners.rules, approvers, codeowners.teams).length) continue;
            let candidates = ownersForFile(filename, codeowners.rules).map(owner => owner.slice(1).toLowerCase())
                .filter(name => name.includes("/")
                    ? (!access || access.teams.has(name)) && (codeowners.teams[name] || []).some(eligibleUser)
                    : eligibleUser(name));
            const mapped = entries.filter(([login, value]) => value >= 0.4 && eligibleUser(login))
                .map(([login]) => login.toLowerCase());
            for (const [source, names] of [["CODEOWNERS", candidates], ["Reviewer mapping", mapped]]) {
                for (const name of names) {
                    if (!additional.has(name) || source === "CODEOWNERS") {
                        additional.set(name, { filename, source });
                    }
                }
            }
            const source = candidates.length ? "CODEOWNERS" : "Reviewer mapping";
            if (!candidates.length) {
                candidates = mapped;
            }
            candidates = [...new Set(candidates)].sort();
            const existing = candidates.find(name => requested.has(name) ||
                (name.includes("/") && (requestedTeams.has(name.split("/")[1]) ||
                    (codeowners.teams[name] || []).some(login => eligibleUser(login) && requested.has(login.toLowerCase())))));
            const reused = candidates.find(name => selected.has(name));
            const choice = existing || reused || candidates[Math.floor(random() * candidates.length)];
            if (choice && !existing) selected.add(choice);
            rows.push({ filename, source, reviewer: choice, existing: Boolean(existing) });
        }
    }
    const alreadyRequested = name => requested.has(name) ||
        (name.includes("/") && requestedTeams.has(name.split("/")[1]));
    const existingCount = requested.size + requestedTeams.size;
    while (existingCount + selected.size < 3) {
        const available = [...additional.keys()].filter(name => !selected.has(name) && !alreadyRequested(name));
        const owners = available.filter(name => additional.get(name).source === "CODEOWNERS");
        const candidates = owners.length ? owners : available;
        if (!candidates.length) break;
        const choice = candidates[Math.floor(random() * candidates.length)];
        selected.add(choice);
        rows.push({ ...additional.get(choice), reviewer: choice, existing: false, additional: true });
    }
    return {
        reviewers: [...selected].filter(name => !name.includes("/")),
        team_reviewers: [...selected].filter(name => name.includes("/")).map(name => name.split("/")[1]),
        rows,
        requestedTotal: existingCount + selected.size,
        excluded: [...excluded].sort(),
    };
}

function assignmentSummary(plan) {
    return [
        "## Reviewer assignment",
        "",
        "| Changed path | Source | Reviewer | Action |",
        "|---|---|---|---|",
        ...plan.rows.map(row => `| <code>${escapeCell(row.filename)}</code> | ${row.source} | ${row.reviewer ? `@${row.reviewer}` : "-"} | ${!row.reviewer ? "No eligible reviewer" : row.existing ? "Already requested" : "Request review"} |`),
        ...(!plan.rows.length ? ["No additional reviewers needed: all changed paths have qualified approval."] : []),
    ].join("\n");
}

module.exports = Object.freeze({ planAssignments, assignmentSummary });
