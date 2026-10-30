#!/usr/bin/env bash
set -euo pipefail

for dependency in python3 gh; do
    if ! command -v "$dependency" >/dev/null 2>&1; then
        printf 'Required command not found: %s\n' "$dependency" >&2
        exit 1
    fi
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 - "$script_dir" "$@" <<'PYTHON'
import argparse
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import html
import json
import math
from pathlib import Path
import posixpath
import re
import random
import subprocess
import sys
from urllib.parse import urlencode

try:
    import yaml
except ModuleNotFoundError:
    sys.exit("PyYAML is required. Install your system's python3-yaml package, or use a virtual environment with: python3 -m pip install PyYAML")


REPO = "sonic-net/sonic-mgmt"
SCRIPT_DIR = Path(sys.argv.pop(1))


class MappingLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        keys = [self.construct_object(key, deep=deep) for key, _ in node.value]
        if any(not isinstance(key, str) for key in keys):
            raise ValueError("Reviewer mapping keys must be strings")
        if len(set(keys)) != len(keys):
            raise ValueError("Duplicate key in reviewer mapping")
        return super().construct_mapping(node, deep=deep)


def parse_mapping(text):
    mapping = yaml.load(text, Loader=MappingLoader)
    if not isinstance(mapping, dict) or not mapping:
        raise ValueError("Reviewer mapping must be a non-empty folder-to-reviewers object")
    for folder, reviewers in mapping.items():
        normalized = posixpath.normpath(folder)
        normalized = "/" if normalized == "/" else normalized + "/"
        if not folder.startswith("/") or "//" in folder or normalized != folder or not isinstance(reviewers, dict):
            raise ValueError(f"Invalid reviewer mapping for folder {folder}")
        for login, score in reviewers.items():
            if not re.fullmatch(r"[a-z\d](?:[a-z\d-]*[a-z\d])?", login, re.I | re.ASCII) or (
                type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1
            ):
                raise ValueError(f"Invalid qualified reviewer {login} for {folder}")
    return mapping


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Missing review submission timestamp")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Review submission timestamp must include a timezone")
    return result


def current_approvers(reviews, pr):
    latest = {}
    for review in reviews:
        if not review.get("user") or review["state"] not in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            continue
        login = review["user"]["login"].lower()
        submitted = timestamp(review.get("submitted_at"))
        previous = latest.get(login)
        if previous is None or (submitted, review["id"]) > (timestamp(previous["submitted_at"]), previous["id"]):
            latest[login] = review
    return {
        login for login, review in latest.items()
        if review["state"] == "APPROVED" and review.get("commit_id") == pr["head"]["sha"]
        and login != pr["user"]["login"].lower() and review["user"].get("type") != "Bot"
        and not login.endswith("[bot]")
    }


def mapped_folder(filename, mapping):
    folder = posixpath.dirname("/" + filename)
    while True:
        key = "/" if folder == "/" else folder + "/"
        if key in mapping:
            return key
        if folder == "/":
            return None
        folder = posixpath.dirname(folder)


def escape_cell(value):
    return html.escape(value, quote=False).replace("|", "&#124;").replace("`", "&#96;").replace("\r", " ").replace("\n", " ")


def parse_codeowners(text):
    rules = []
    for number, line in enumerate(text.splitlines(), 1):
        fields = line.split("#", 1)[0].split()
        if not fields:
            continue
        pattern, *owners = fields
        if any(char in pattern for char in "!\\[]") or any(
            not re.fullmatch(r"@[a-z\d-]+(?:/[a-z\d_-]+)?", owner, re.I | re.ASCII) for owner in owners
        ):
            raise ValueError(f"Unsupported CODEOWNERS syntax on line {number}")
        glob = pattern.lstrip("/").rstrip("/")
        expression = ""
        index = 0
        while index < len(glob):
            if glob[index:index + 3] == "**/":
                expression += "(?:.*/)?"
                index += 3
            elif glob[index:index + 2] == "**":
                expression += ".*"
                index += 2
            else:
                expression += "[^/]*" if glob[index] == "*" else "[^/]" if glob[index] == "?" else re.escape(glob[index])
                index += 1
        prefix = "^" if pattern.startswith("/") or "/" in glob else "(?:^|/)"
        suffix = "/.*$" if pattern.endswith("/") else "(?:/.*)?$"
        rules.append((re.compile(prefix + expression + suffix), owners))
    return rules


def approved_owners(filename, rules, approvers, teams):
    owners = []
    for pattern, matches in rules:
        if pattern.search(filename):
            owners = matches
    return [
        owner for owner in owners
        if (any(login.lower() in approvers for login in teams.get(owner[1:].lower(), []))
            if "/" in owner else owner[1:].lower() in approvers)
    ]


def assignment_preview(files, mapping, reviews, pr, codeowners, access):
    if pr.get("draft") or pr["state"] != "open":
        return "## Reviewer assignment preview\n\nSkipped: PR is draft or closed."
    approvers = current_approvers(reviews, pr)
    author = pr["user"]["login"].lower()
    requested = {user["login"].lower() for user in pr.get("requested_reviewers", [])}
    requested_teams = {team["slug"].lower() for team in pr.get("requested_teams", [])}
    selected = set()
    additional = {}
    rows = []
    def eligible_user(login):
        return (login.lower() not in (author, "mssonicbld") and not login.lower().endswith("[bot]")
                and login.lower() in access[0])

    for file in files:
        paths = [file["filename"]]
        if file.get("status") == "renamed":
            paths.append(file["previous_filename"])
        for filename in dict.fromkeys(paths):
            folder = mapped_folder(filename, mapping)
            entries = {} if folder is None else mapping[folder]
            score = sum((Decimal(str(value)) for login, value in entries.items() if login.lower() in approvers), Decimal(0))
            if score >= Decimal("0.4") or approved_owners(filename, codeowners[0], approvers, codeowners[1]):
                continue
            owners = []
            for pattern, matches in codeowners[0]:
                if pattern.search(filename):
                    owners = matches
            candidates = []
            for owner in owners:
                name = owner[1:].lower()
                eligible = (name in access[1] and any(eligible_user(login)
                            for login in codeowners[1].get(name, []))) if "/" in name else eligible_user(name)
                if eligible:
                    candidates.append(name)
            source = "CODEOWNERS" if candidates else "Reviewer mapping"
            mapped = [login.lower() for login, value in entries.items() if value >= 0.4 and eligible_user(login)]
            for candidate_source, names in (("CODEOWNERS", candidates), ("Reviewer mapping", mapped)):
                for name in names:
                    if name not in additional or candidate_source == "CODEOWNERS":
                        additional[name] = (filename, candidate_source)
            if not candidates:
                candidates = mapped
            candidates = sorted(set(candidates))
            existing = next((name for name in candidates if name in requested or
                             ("/" in name and (name.split("/")[1] in requested_teams or
                              any(eligible_user(login) and login.lower() in requested
                                  for login in codeowners[1].get(name, []))))), None)
            reused = next((name for name in candidates if name in selected), None)
            choice = existing or reused or (random.choice(candidates) if candidates else None)
            if choice and not existing:
                selected.add(choice)
            action = "No eligible reviewer" if not choice else "Already requested" if existing else "Would request review"
            rows.append(f"| <code>{escape_cell(filename)}</code> | {source} | {'@' + choice if choice else '-'} | {action} |")
    existing_count = len(requested) + len(requested_teams)
    while existing_count + len(selected) < 3:
        available = sorted(name for name in additional if name not in selected and name not in requested
                           and not ("/" in name and name.split("/")[1] in requested_teams))
        owners = [name for name in available if additional[name][1] == "CODEOWNERS"]
        candidates = owners or available
        if not candidates:
            break
        choice = random.choice(candidates)
        selected.add(choice)
        filename, source = additional[choice]
        rows.append(f"| <code>{escape_cell(filename)}</code> | {source} | @{choice} | Would request additional review (minimum three) |")
    total = existing_count + len(selected)
    return "\n".join([
        "## Reviewer assignment preview", "", "Read-only: no review requests were sent.", "",
        "| Changed path | Source | Reviewer | Action |", "|---|---|---|---|",
        *(rows or ["No additional reviewers needed: all changed paths have qualified approval."]),
        "", f"Review requests after this plan: {total} (target: at least 3).",
        *(["Fewer than three eligible requests are available for the remaining unqualified paths."] if rows and total < 3 else []),
    ])


def load_codeowners(filename):
    if not filename.is_file():
        print(f"CODEOWNERS not found at {filename}; using scores only.", file=sys.stderr)
        return [], {}
    rules = parse_codeowners(filename.read_text(encoding="utf-8"))
    teams = {}
    for name in sorted({owner[1:].lower() for _, owners in rules for owner in owners if "/" in owner}):
        org, slug = name.split("/")
        teams[name] = [member["login"] for member in list_pages(f"orgs/{org}/teams/{slug}/members")]
    return rules, teams


def summary(files, mapping, reviews, pr, mapping_link, codeowners=((), {}), codeowners_link=None):
    if len(files) != pr["changed_files"]:
        raise ValueError(f"Incomplete changed-file list: received {len(files)} of {pr['changed_files']}")
    approvers = current_approvers(reviews, pr)
    groups = {}
    covered = 0
    for file in files:
        paths = [file["filename"]]
        if file.get("status") == "renamed":
            if not file.get("previous_filename"):
                raise ValueError(f"Missing previous filename for renamed file {file['filename']}")
            paths.append(file["previous_filename"])
        approved = True
        for filename in dict.fromkeys(paths):
            folder = mapped_folder(filename, mapping)
            matches = [] if folder is None else sorted(login for login in mapping[folder] if login.lower() in approvers)
            score = sum((Decimal(str(mapping[folder][login])) for login in matches), Decimal(0))
            owners = approved_owners(filename, codeowners[0], approvers, codeowners[1])
            area = posixpath.dirname("/" + filename).rstrip("/") + "/"
            group = groups.setdefault(area, {"folder": folder, "files": set(), "matches": matches, "score": score,
                                             "owners": set(), "qualified": True})
            group["files"].add(file["filename"])
            group["owners"].update(owners)
            qualified = score >= Decimal("0.4") or bool(owners)
            group["qualified"] = group["qualified"] and qualified
            approved = approved and qualified
        covered += int(approved)
    lines = [
        "<!-- sonic-qualified-approval-coverage -->",
        "## Qualified approval coverage", "",
        f"**{covered} of {len(files)} changed files have qualified approval** for head commit `{pr['head']['sha']}`.", "",
        ("**All changed folders have qualified approval.** The `Qualified-approval` label indicates this PR meets the qualified-approval requirement for auto-merge."
         if files and covered == len(files) else
         "This PR does not yet meet the qualified-approval requirement for auto-merge. The `Qualified-approval` label is applied only when all changed folders have qualified approval."),
        "Read-only preview: the label was not changed.", "",
        "A folder qualifies when the sum of its mapped active approvers' scores is **at least 0.4**. Each approver counts once per folder; a total of exactly 0.4 qualifies.", "",
        "Alternatively, a file qualifies through approval by a matching CODEOWNER (including team members). The last matching CODEOWNERS rule wins. A folder is approved only if all changed paths in it qualify; missing CODEOWNERS does not disable score-based qualification.", "",
        "| Changed folder | Files | Reviewer mapping | Status | Mapped approvers | Approval score | Approving code owners |",
        "|---|---:|---|---|---|---:|---|",
    ]
    for area, group in sorted(groups.items())[:100]:
        folder = group["folder"]
        status = "Approved" if group["qualified"] else "No reviewer mapping" if folder is None else "Awaiting qualified approval"
        mapped = "-" if folder is None else f"<code>{escape_cell(folder)}</code>"
        names = ", ".join("@" + login for login in group["matches"]) or "-"
        owner_names = ", ".join(sorted(group["owners"])) or "-"
        lines.append(f"| <code>{escape_cell(area)}</code> | {len(group['files'])} | {mapped} | {status} | {names} | {group['score']} | {owner_names} |")
    if len(groups) > 100:
        lines.extend(["", f"Showing 100 of {len(groups)} changed folders; the coverage total includes all files."])
    lines.extend([
        "", f"[Reviewer mapping]({mapping_link})",
        f"[CODEOWNERS]({codeowners_link})" if codeowners_link else "CODEOWNERS: not available.", "",
        '<div align="right"><sub>---Powered by SONiC BuildBot</sub></div>',
    ])
    return "\n".join(lines)


def api(endpoint, missing_ok=False):
    result = subprocess.run(
        ["gh", "api", "--hostname", "github.com", "--method", "GET", endpoint],
        check=False, stdout=subprocess.PIPE, encoding="utf-8", timeout=60,
    )
    if result.returncode:
        if missing_ok:
            try:
                error = json.loads(result.stdout)
            except json.JSONDecodeError:
                error = {}
            if str(error.get("status")) == "404":
                print(f"Repository team access not found: {endpoint}; excluding team.", file=sys.stderr)
                return None
        raise subprocess.CalledProcessError(result.returncode, result.args, output=result.stdout)
    return json.loads(result.stdout)


def list_pages(endpoint):
    items = []
    page = 1
    while True:
        batch = api(f"{endpoint}?per_page=100&page={page}")
        if not isinstance(batch, list):
            raise ValueError(f"Expected an array from {endpoint}")
        items.extend(batch)
        if len(batch) < 100:
            return items
        page += 1


def load_reviewer_access(codeowners):
    collaborators = list_pages(f"repos/{REPO}/collaborators")
    users = {user["login"].lower() for user in collaborators if user.get("type") != "Bot"}
    teams = set()
    owner, repo = REPO.split("/")
    for name in codeowners[1]:
        org, slug = name.split("/")
        if org != owner.lower():
            print(f"Excluding team {name}: not in repository organization", file=sys.stderr)
            continue
        if api(f"orgs/{org}/teams/{slug}/repos/{owner}/{repo}", missing_ok=True) is not None:
            teams.add(name)
    return users, teams


def run(options):
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=options.days)
    mapping_path = options.mapping.resolve(strict=True)
    mapping = parse_mapping(mapping_path.read_text(encoding="utf-8"))
    if options.report.resolve() == mapping_path or (
        options.report.exists() and options.report.samefile(mapping_path)
    ):
        raise ValueError("The report must not overwrite the reviewer mapping")
    if options.report.resolve() == options.codeowners.resolve() or (
        options.report.exists() and options.codeowners.exists() and options.report.samefile(options.codeowners)
    ):
        raise ValueError("The report must not overwrite CODEOWNERS")

    def append(text):
        with options.report.open("a", encoding="utf-8") as report:
            report.write(text + "\n")

    append("\n".join([
        "", "---", "", f"# Local qualified approval report: {REPO}", "",
        f"Run: {now.isoformat()}",
        f"Approval window: {since.isoformat()} to {now.isoformat()}",
        f"Local mapping: [{mapping_path.name}]({mapping_path.as_uri()})",
        f"Local CODEOWNERS: {options.codeowners.resolve()} (optional)",
        f"Scope: open and merged PRs; maximum {options.limit} results, ordered by PR update time.",
        "Read-only preview: no comments were published. Only approvals for each PR's current head count toward coverage.",
        "Merged PRs are evaluated at their retained PR head, not the merge commit. This is not a reconstruction of historical mapping or merge-time approval policy.", "",
    ]))
    reported = examined = 0
    reviewer_access = None
    try:
        codeowners = load_codeowners(options.codeowners)
        codeowners_link = options.codeowners.resolve().as_uri() if options.codeowners.is_file() else None
        query = f"repo:{REPO} is:pr review:approved updated:>={since.date().isoformat()}"
        for page in range(1, 11):
            search = api("search/issues?" + urlencode({
                "q": query, "sort": "updated", "order": "desc", "per_page": 100, "page": page,
            }))
            if search.get("incomplete_results") or not isinstance(search.get("items"), list):
                raise ValueError("GitHub returned an incomplete or invalid PR search")
            for item in search["items"]:
                endpoint = f"repos/{REPO}/pulls/{item['number']}"
                pr = api(endpoint)
                examined += 1
                if pr["state"] != "open" and not pr["merged"]:
                    continue
                reviews = list_pages(endpoint + "/reviews")
                recent = [
                    review for review in reviews
                    if review["state"] == "APPROVED" and since <= timestamp(review.get("submitted_at")) <= now
                ]
                if not recent:
                    continue
                files = list_pages(endpoint + "/files")
                comment = summary(files, mapping, reviews, pr, mapping_path.as_uri(), codeowners, codeowners_link)
                if pr["state"] == "open" and not pr.get("draft") and reviewer_access is None:
                    reviewer_access = load_reviewer_access(codeowners)
                preview = assignment_preview(files, mapping, reviews, pr, codeowners, reviewer_access)
                current = api(endpoint)
                if any(current[key] != pr[key] for key in ("state", "merged")) or (
                    current["head"]["sha"] != pr["head"]["sha"] or current["base"]["sha"] != pr["base"]["sha"]
                ):
                    raise ValueError(f"PR #{pr['number']} changed during evaluation; rerun for a consistent snapshot")
                state = "merged" if pr["merged"] else "open"
                latest_approval = max(timestamp(review["submitted_at"]) for review in recent)
                append("\n".join([
                    f"### [{REPO}#{pr['number']}](https://github.com/{REPO}/pull/{pr['number']})", "",
                    f"State: {state}. Most recent approval in window: {latest_approval.isoformat()}.",
                    "", comment, "", preview, "", "---", "",
                ]))
                reported += 1
                print(f"Appended {REPO}#{pr['number']} ({state})")
                if reported == options.limit:
                    break
            if reported == options.limit or page * 100 >= search["total_count"] or len(search["items"]) < 100:
                break
            if page == 10:
                raise ValueError("Reached GitHub's 1000-result search limit; narrow --days")
        no_matches = "" if reported else " No matching recent approvals found."
        append(f"Run complete: appended {reported} PR preview(s); examined {examined} candidate(s).{no_matches}\n")
        print(f"Report: {options.report} ({reported} PRs)")
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        append(f"**Run failed after {reported} preview(s):** {' '.join(str(error).splitlines())}\n")
        raise


def positive_int(value):
    if not re.fullmatch(r"[0-9]+", value) or int(value) < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return int(value)


def main():
    parser = argparse.ArgumentParser(
        prog="qualified_approvals_report.sh",
        description=f"Read-only report for recently approved open and merged {REPO} PRs. No Node.js required.",
        epilog="Only GitHub GET requests are sent. Comments are appended locally, never published.",
    )
    parser.add_argument("--mapping", type=Path, default=SCRIPT_DIR / "../../sonic-tsc/pr_reviewer/sonic-mgmt/pr_reviewer-by-files.yml",
                        help="local mapping YAML (default: sibling sonic-tsc checkout)")
    parser.add_argument("--report", type=Path, default=Path("qualified-approvals-report.md"),
                        help="append Markdown here (default: ./qualified-approvals-report.md)")
    parser.add_argument("--codeowners", type=Path, default=SCRIPT_DIR / "../../sonic-mgmt/.github/CODEOWNERS",
                        help="optional CODEOWNERS file (default: sibling sonic-mgmt checkout; missing is allowed)")
    parser.add_argument("--days", type=positive_int, default=7, help="approval lookback in days (default: 7)")
    parser.add_argument("--limit", type=positive_int, default=10, help="maximum PRs, newest updated first (default: 10; maximum: 1000)")
    options = parser.parse_args()
    if options.limit > 1000:
        parser.error("--limit must be at most 1000")
    try:
        run(options)
    except (OSError, ValueError, KeyError, TypeError, OverflowError, subprocess.CalledProcessError, subprocess.TimeoutExpired, yaml.YAMLError) as error:
        sys.exit(f"Qualified approval report failed: {error}")


if __name__ == "__main__":
    main()
PYTHON
