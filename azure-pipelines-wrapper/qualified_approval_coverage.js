const yaml = require("js-yaml");
const path = require("path").posix;
const { approvedOwners } = require("./codeowners");

const marker = "<!-- sonic-qualified-approval-coverage -->";
const qualifiedApprovalLabel = "Qualified-approval";

function parseMapping(text) {
    const mapping = yaml.safeLoad(text, { schema: yaml.JSON_SCHEMA });
    const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
    if (!isObject(mapping) || !Object.keys(mapping).length) {
        throw new Error("Reviewer mapping must be a non-empty folder-to-reviewers object");
    }
    for (const [folder, reviewers] of Object.entries(mapping)) {
        if (!folder.startsWith("/") || !folder.endsWith("/") ||
            path.normalize(folder) !== folder || !isObject(reviewers)) {
            throw new Error(`Invalid reviewer mapping for folder ${folder}`);
        }
        for (const [login, score] of Object.entries(reviewers)) {
            if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(login) ||
                typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
                throw new Error(`Invalid qualified reviewer ${login} for ${folder}`);
            }
        }
    }
    return mapping;
}

function mappedFolder(filename, mapping) {
    let folder = path.dirname(`/${filename}`);
    while (true) {
        const key = folder === "/" ? "/" : `${folder}/`;
        if (Object.prototype.hasOwnProperty.call(mapping, key)) {
            return key;
        }
        if (folder === "/") {
            return null;
        }
        folder = path.dirname(folder);
    }
}

function currentApprovers(reviews, pr) {
    const latest = new Map();
    for (const review of reviews) {
        if (!review.user || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
            continue;
        }
        const submitted = Date.parse(review.submitted_at);
        if (!Number.isFinite(submitted)) {
            throw new Error(`Missing or invalid submission time for review ${review.id}`);
        }
        const login = review.user.login.toLowerCase();
        const previous = latest.get(login);
        if (!previous || submitted > Date.parse(previous.submitted_at) ||
            (submitted === Date.parse(previous.submitted_at) && review.id > previous.id)) {
            latest.set(login, review);
        }
    }
    return new Set([...latest.entries()].filter(([login, review]) =>
        review.state === "APPROVED" && review.commit_id === pr.head.sha &&
        login !== pr.user.login.toLowerCase() && review.user.type !== "Bot" &&
        !login.endsWith("[bot]")).map(([login]) => login));
}

function escapeCell(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\|/g, "&#124;").replace(/`/g, "&#96;").replace(/[\r\n]/g, " ");
}

function approvalScore(scores) {
    // Sum decimal weights exactly to avoid rounding errors at the threshold.
    const parts = scores.map(score => {
        const [coefficient, exponent = "0"] = score.toString().split("e");
        const [whole, fraction = ""] = coefficient.split(".");
        return { digits: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
    });
    const scale = Math.max(0, ...parts.map(part => part.scale));
    const total = parts.reduce((sum, part) =>
        sum + part.digits * (10n ** BigInt(scale - part.scale)), 0n);
    return Number(`${total}e-${scale}`);
}

function coverage(files, mapping, reviews, pr, mappingLink, codeowners = { rules: [], teams: {} }) {
    if (files.length !== pr.changed_files) {
        throw new Error(`Incomplete changed-file list: received ${files.length} of ${pr.changed_files}`);
    }
    const approvers = currentApprovers(reviews, pr);
    const groups = new Map();
    let covered = 0;
    for (const file of files) {
        const paths = new Set([file.filename]);
        if (file.status === "renamed") {
            if (!file.previous_filename) {
                throw new Error(`Missing previous filename for renamed file ${file.filename}`);
            }
            paths.add(file.previous_filename);
        }
        let approved = true;
        for (const filename of paths) {
            const folder = mappedFolder(filename, mapping);
            const matches = folder === null ? [] :
                Object.keys(mapping[folder]).filter(login => approvers.has(login.toLowerCase())).sort();
            const score = approvalScore(matches.map(login => mapping[folder][login]));
            const owners = approvedOwners(filename, codeowners.rules, approvers, codeowners.teams);
            const area = `${path.dirname(`/${filename}`).replace(/\/$/, "")}/`;
            if (!groups.has(area)) {
                groups.set(area, { folder, files: new Set(), matches, score, owners: new Set(), qualified: true });
            }
            groups.get(area).files.add(file.filename);
            owners.forEach(owner => groups.get(area).owners.add(owner));
            const qualified = score >= 0.4 || owners.length > 0;
            groups.get(area).qualified = groups.get(area).qualified && qualified;
            approved = approved && qualified;
        }
        if (approved) {
            covered += 1;
        }
    }
    const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    const qualified = files.length > 0 && covered === files.length;
    const body = [
        marker,
        "## Qualified approval coverage",
        "",
        `**${covered} of ${files.length} changed files have qualified approval** for head commit \`${pr.head.sha}\`.`,
        "",
        qualified
            ? `**All changed folders have qualified approval.** The \`${qualifiedApprovalLabel}\` label indicates this PR meets the qualified-approval requirement for auto-merge.`
            : `This PR does not yet meet the qualified-approval requirement for auto-merge. The \`${qualifiedApprovalLabel}\` label is applied only when all changed folders have qualified approval.`,
        "",
        "A folder qualifies when the sum of its mapped active approvers' scores is **at least 0.4**. Each approver counts once per folder; a total of exactly 0.4 qualifies.",
        "Alternatively, a file qualifies through approval by a matching CODEOWNER (including team members).",
        "",
        "| Changed folder | Files | Reviewer mapping | Status | Mapped approvers | Approval score | Approving code owners |",
        "|---|---:|---|---|---|---:|---|",
        ...rows.slice(0, 100).map(([area, group]) => {
            const status = group.qualified ? "Approved" :
                group.folder === null ? "No reviewer mapping" : "Awaiting qualified approval";
            return `| <code>${escapeCell(area)}</code> | ${group.files.size} | ${group.folder === null ? "-" : `<code>${escapeCell(group.folder)}</code>`} | ${status} | ${group.matches.map(login => `@${login}`).join(", ") || "-"} | ${group.score} | ${[...group.owners].sort().join(", ") || "-"} |`;
        }),
        ...(rows.length > 100 ? ["", `Showing 100 of ${rows.length} changed folders; the coverage total includes all files.`] : []),
        "",
        `[Reviewer mapping](${mappingLink})`,
        codeowners.link ? `[CODEOWNERS](${codeowners.link})` : "CODEOWNERS: not available.",
        "",
        '<div align="right"><sub>---Powered by SONiC BuildBot</sub></div>',
    ].join("\n");
    return { body, qualified };
}

function summary(...args) {
    return coverage(...args).body;
}

module.exports = Object.freeze({
    marker, qualifiedApprovalLabel, parseMapping, coverage, summary, mappedFolder, currentApprovers, approvalScore, escapeCell,
});
