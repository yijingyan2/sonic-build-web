import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone


SCRIPT = Path(__file__).resolve().parents[1] / "qualified_approvals_report.sh"
BASE = "repos/sonic-net/sonic-mgmt/pulls/"


def pr(number, state="open", merged=False):
    return {
        "number": number, "state": state, "merged": merged,
        "head": {"sha": "head"}, "base": {"sha": "base"},
        "changed_files": 1, "user": {"login": "author"},
    }


class QualifiedApprovalReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qualified-approvals-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.mapping = self.directory / "mapping.yml"
        self.report = self.directory / "report.md"
        self.fixture = self.directory / "responses.json"
        self.calls = self.directory / "requests.jsonl"
        self.mapping.write_text("/tests/: {Alice: 0.6}\n/ansible/: {Bob: 0.5}\n", encoding="utf-8")
        self.approval = {
            "id": 1, "state": "APPROVED", "user": {"login": "Alice", "type": "User"},
            "commit_id": "head",
            "submitted_at": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
        }
        self.files = [{"filename": "tests/test.py", "status": "modified"}]
        self.responses = {
            "search": {"total_count": 4, "incomplete_results": False, "items": [{"number": n} for n in (101, 102, 103, 104)]},
            "repos/sonic-net/sonic-mgmt/collaborators?per_page=100&page=1": [
                {"login": name, "type": "User"} for name in ("Alice", "Bob", "Carol", "Dave", "Owner", "Other", "Member", "Low", "RootOwner")
            ],
            "orgs/sonic-net/teams/test-maintainers/repos/sonic-net/sonic-mgmt": {},
        }
        for number, state, merged in ((101, "open", False), (102, "closed", True), (103, "closed", False), (104, "open", False)):
            endpoint = BASE + str(number)
            self.responses[endpoint] = pr(number, state, merged)
            self.responses[endpoint + "/reviews?per_page=100&page=1"] = [self.approval]
            self.responses[endpoint + "/files?per_page=100&page=1"] = self.files
        self.responses[BASE + "104/reviews?per_page=100&page=1"] = [{
            **self.approval, "submitted_at": (datetime.now(timezone.utc) - timedelta(days=60)).isoformat(),
        }]
        gh = self.directory / "gh"
        gh.write_text(f"#!{sys.executable}\n" + """
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
if args[:5] != ["api", "--hostname", "github.com", "--method", "GET"]:
    sys.exit("Only explicit read-only GitHub requests are allowed")
log = Path(os.environ["TEST_GH_CALLS"])
with log.open("a") as output:
    output.write(json.dumps(args) + "\\n")
responses = json.loads(Path(os.environ["TEST_GH_FIXTURE"]).read_text())
endpoint = args[-1]
key = endpoint if endpoint in responses else "search" if endpoint.startswith("search/issues?") else endpoint
if key not in responses:
    sys.exit("Unexpected request: " + endpoint)
response = responses[key]
if isinstance(response, dict) and "__sequence" in response:
    count = sum(
        json.loads(line)[-1].startswith("search/issues?") if key == "search"
        else json.loads(line)[-1] == endpoint
        for line in log.read_text().splitlines()
    )
    response = response["__sequence"][count - 1]
if isinstance(response, dict) and "__error" in response:
    if "status" in response:
        print(json.dumps({"status": response["status"]}))
    sys.exit(response["__error"])
print(json.dumps(response))
""", encoding="utf-8")
        gh.chmod(0o755)
        self.env = {
            **os.environ, "PATH": str(self.directory) + os.pathsep + os.environ["PATH"],
            "TEST_GH_CALLS": str(self.calls), "TEST_GH_FIXTURE": str(self.fixture),
            "PYTHONDONTWRITEBYTECODE": "1",
        }

    def execute(self, *args, success=True):
        self.fixture.write_text(json.dumps(self.responses), encoding="utf-8")
        result = subprocess.run(
            ["bash", str(SCRIPT), "--mapping", str(self.mapping), "--report", str(self.report),
             "--codeowners", str(self.directory / "CODEOWNERS"), *args],
            cwd=self.directory, env=self.env, capture_output=True, text=True,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def text(self):
        return self.report.read_text(encoding="utf-8")

    def request_args(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def test_help_runs_without_node(self):
        result = self.execute("--help")
        self.assertIn("No Node.js required", result.stdout)
        self.assertEqual(self.request_args(), [])
        self.assertFalse(self.report.exists())

    def test_complete_coverage_explains_label_and_auto_merge_without_writes(self):
        self.execute("--limit", "1")
        self.assertIn("**All changed folders have qualified approval.**", self.text())
        self.assertIn("`Qualified-approval`", self.text())
        self.assertIn("meets the qualified-approval requirement for auto-merge", self.text())
        self.assertIn("including required checks, branch protection", self.text())
        self.assertIn("Read-only preview: the label was not changed.", self.text())
        for args in self.request_args():
            self.assertEqual(args[:5], ["api", "--hostname", "github.com", "--method", "GET"])

    def test_partial_coverage_does_not_claim_auto_merge_approval_requirement_met(self):
        self.mapping.write_text("/tests/: {Bob: 0.4}\n")
        self.execute("--limit", "1")
        self.assertIn("does not yet meet the qualified-approval requirement for auto-merge", self.text())
        self.assertNotIn("**All changed folders have qualified approval.**", self.text())

    def test_empty_pr_does_not_qualify_for_label(self):
        self.responses[BASE + "101"]["changed_files"] = 0
        self.responses[BASE + "101/files?per_page=100&page=1"] = []
        self.execute("--limit", "1")
        self.assertNotIn("**All changed folders have qualified approval.**", self.text())

    def test_assignment_preview_prefers_codeowners_and_sends_only_get_requests(self):
        self.mapping.write_text("/tests/: {Bob: 0.4}\n")
        (self.directory / "CODEOWNERS").write_text("* @Owner\n")
        self.execute("--limit", "1")
        self.assertIn("## Reviewer assignment preview", self.text())
        self.assertIn("| CODEOWNERS | @owner | Would request review |", self.text())
        self.assertIn("| Reviewer mapping | @bob | Would request additional review (minimum three) |", self.text())
        for args in self.request_args():
            self.assertEqual(args[:5], ["api", "--hostname", "github.com", "--method", "GET"])

    def test_assignment_preview_reuses_requested_mapping_reviewer(self):
        self.mapping.write_text("/tests/: {Bob: 0.4, Carol: 0.6}\n")
        self.responses[BASE + "101"]["requested_reviewers"] = [{"login": "Bob"}]
        self.execute("--limit", "1")
        self.assertIn("| Reviewer mapping | @bob | Already requested |", self.text())

    def test_assignment_preview_reports_below_threshold_candidates(self):
        self.mapping.write_text("/tests/: {Bob: 0.3}\n")
        self.execute("--limit", "1")
        self.assertIn("No eligible reviewer", self.text())

    def test_assignment_preview_tops_up_to_three_requests(self):
        self.mapping.write_text("/tests/: {Bob: 0.4, Carol: 0.5, Dave: 0.6, Low: 0.3}\n")
        self.responses[BASE + "101"]["requested_reviewers"] = [{"login": "Bob"}]
        self.execute("--limit", "1")
        self.assertIn("Review requests after this plan: 3 (target: at least 3).", self.text())
        self.assertIn("@carol | Would request additional review", self.text())
        self.assertIn("@dave | Would request additional review", self.text())
        self.assertNotIn("@low", self.text())

    def test_assignment_preview_counts_team_and_user_requests(self):
        self.mapping.write_text("/tests/: {Bob: 0.4, Carol: 0.5}\n")
        self.responses[BASE + "101"]["requested_reviewers"] = [{"login": "Bob"}]
        self.responses[BASE + "101"]["requested_teams"] = [{"slug": "existing-team"}]
        self.execute("--limit", "1")
        self.assertIn("Review requests after this plan: 3 (target: at least 3).", self.text())
        self.assertIn("@carol | Would request additional review", self.text())

    def test_assignment_preview_reports_shortage(self):
        self.mapping.write_text("/tests/: {Bob: 0.4}\n")
        self.execute("--limit", "1")
        self.assertIn("Review requests after this plan: 1 (target: at least 3).", self.text())
        self.assertIn("Fewer than three eligible requests", self.text())

    def test_assignment_preview_filters_non_collaborators(self):
        self.mapping.write_text("/tests/: {Bob: 0.4, Stranger: 0.9}\n")
        self.execute("--limit", "1")
        self.assertIn("@bob | Would request review", self.text())
        self.assertNotIn("@stranger", self.text())

    def test_assignment_preview_rejects_team_without_repository_access(self):
        self.mapping.write_text("/tests/: {Bob: 0.4}\n")
        (self.directory / "CODEOWNERS").write_text("* @sonic-net/test-maintainers\n")
        self.responses["orgs/sonic-net/teams/test-maintainers/members?per_page=100&page=1"] = [{"login": "Member"}]
        self.responses["orgs/sonic-net/teams/test-maintainers/repos/sonic-net/sonic-mgmt"] = {
            "__error": "Not found", "status": "404",
        }
        self.execute("--limit", "1")
        self.assertIn("| Reviewer mapping | @bob |", self.text())
        self.assertNotIn("| CODEOWNERS | @sonic-net/test-maintainers |", self.text())

    def test_assignment_preview_fails_explicitly_if_access_cannot_be_checked(self):
        self.responses["repos/sonic-net/sonic-mgmt/collaborators?per_page=100&page=1"] = {"__error": "Forbidden"}
        self.execute("--limit", "1", success=False)
        self.assertIn("Run failed", self.text())
        self.assertNotIn("Run complete", self.text())

    def test_assignment_preview_skips_drafts_and_closed_prs(self):
        self.responses[BASE + "101"]["draft"] = True
        self.execute()
        self.assertEqual(self.text().count("Skipped: PR is draft or closed."), 2)

    def test_codeowner_approval_qualifies_without_sufficient_score(self):
        self.mapping.write_text("/tests/: {Alice: 0.1}\n")
        (self.directory / "CODEOWNERS").write_text("* @Other\n/tests/ @Alice\n")
        self.execute("--limit", "1")
        self.assertIn("**1 of 1", self.text())
        self.assertIn("| 0.1 | @Alice |", self.text())
        self.assertIn(f"[CODEOWNERS]({(self.directory / 'CODEOWNERS').as_uri()})", self.text())

    def test_last_matching_rule_and_partial_folder_coverage(self):
        self.mapping.write_text("/tests/: {Other: 0.1}\n")
        (self.directory / "CODEOWNERS").write_text("* @Alice\n/tests/private.py @Other\n")
        self.responses[BASE + "101"]["changed_files"] = 2
        self.responses[BASE + "101/files?per_page=100&page=1"] = [
            {"filename": "tests/public.py"}, {"filename": "tests/private.py"},
        ]
        self.execute("--limit", "1")
        self.assertIn("**1 of 2", self.text())
        self.assertIn("| Awaiting qualified approval |", self.text())

    def test_codeowner_team_membership(self):
        self.mapping.write_text("/tests/: {Other: 0.1}\n")
        (self.directory / "CODEOWNERS").write_text("/tests/ @sonic-net/test-maintainers\n")
        self.responses["orgs/sonic-net/teams/test-maintainers/members?per_page=100&page=1"] = [{"login": "Alice"}]
        self.execute("--limit", "1")
        self.assertIn("**1 of 1", self.text())
        self.assertIn("@sonic-net/test-maintainers", self.text())

    def test_team_lookup_failure_is_not_treated_as_missing_codeowners(self):
        (self.directory / "CODEOWNERS").write_text("* @sonic-net/test-maintainers\n")
        self.responses["orgs/sonic-net/teams/test-maintainers/members?per_page=100&page=1"] = {"__error": "Team access denied"}
        self.execute(success=False)
        self.assertIn("Run failed", self.text())
        self.assertNotIn("Run complete", self.text())

    def test_open_and_merged_prs_with_recent_approvals(self):
        self.execute()
        text = self.text()
        self.assertIn("sonic-net/sonic-mgmt#101", text)
        self.assertIn("sonic-net/sonic-mgmt#102", text)
        self.assertIn("State: merged", text)
        self.assertNotIn("sonic-net/sonic-mgmt#103", text)
        self.assertNotIn("sonic-net/sonic-mgmt#104", text)
        self.assertIn("appended 2 PR preview(s); examined 4", text)
        self.assertIn("| <code>/tests/</code> | 1 | <code>/tests/</code> | Approved | @Alice |", text)
        self.assertIn(self.mapping.as_uri(), text)
        self.assertIn("CODEOWNERS: not available.", text)
        for args in self.request_args():
            self.assertEqual(args[:5], ["api", "--hostname", "github.com", "--method", "GET"])
            self.assertNotIn("comments", args[-1])

    def test_report_is_appended_and_limit_is_respected(self):
        self.report.write_text("Previous report\n")
        self.execute("--limit", "1")
        self.execute("--limit", "1")
        self.assertTrue(self.text().startswith("Previous report\n"))
        self.assertEqual(self.text().count("# Local qualified approval report:"), 2)
        self.assertNotIn("sonic-net/sonic-mgmt#102", self.text())

    def test_current_head_required_for_merged_prs(self):
        self.responses[BASE + "102"]["head"]["sha"] = "new-head"
        self.execute()
        self.assertIn("**0 of 1 changed files have qualified approval** for head commit `new-head`", self.text())

    def test_summed_scores_must_be_at_least_point_four(self):
        for alice, bob, qualified in ((0.2, 0.19, False), (0.2, 0.2, True), (0.2, 0.2001, True),
                                       (0.4, 0, True), (0.4001, 0, True)):
            with self.subTest(alice=alice, bob=bob):
                self.mapping.write_text(f"/tests/: {{Alice: {alice}, Bob: {bob}}}\n")
                self.responses[BASE + "101/reviews?per_page=100&page=1"] = [
                    self.approval, {**self.approval, "id": 2, "user": {"login": "BOB", "type": "User"}},
                ]
                self.execute("--limit", "1")
                self.assertIn(f"**{int(qualified)} of 1", self.text())
                status = "Approved" if qualified else "Awaiting qualified approval"
                self.assertIn(f"| {status} | @Alice, @Bob |", self.text())
                self.assertIn("exactly 0.4 qualifies", self.text())
                self.report.unlink()

    def test_repeated_reviews_do_not_increase_the_approver_score(self):
        self.mapping.write_text("/tests/: {Alice: 0.3}\n")
        self.responses[BASE + "101/reviews?per_page=100&page=1"] = [
            self.approval, {**self.approval, "id": 2},
        ]
        self.execute("--limit", "1")
        self.assertIn("**0 of 1", self.text())
        self.assertIn("| Awaiting qualified approval | @Alice | 0.3 |", self.text())

    def test_decimal_scores_totaling_exact_threshold_qualify(self):
        users = [f"Reviewer{i}" for i in range(40)]
        self.mapping.write_text("/tests/: {" + ", ".join(f"{login}: 0.01" for login in users) + "}\n")
        self.responses[BASE + "101/reviews?per_page=100&page=1"] = [
            {**self.approval, "id": i + 1, "user": {"login": login, "type": "User"}}
            for i, login in enumerate(users)
        ]
        self.execute("--limit", "1")
        self.assertIn("**1 of 1", self.text())
        self.assertIn("| Approved |", self.text())

    def test_scores_are_not_pooled_across_folders(self):
        self.mapping.write_text("/tests/: {Alice: 0.3}\n/ansible/: {Bob: 0.3}\n")
        self.responses[BASE + "101"]["changed_files"] = 2
        self.responses[BASE + "101/files?per_page=100&page=1"] = [
            {"filename": "tests/test.py"}, {"filename": "ansible/task.yml"},
        ]
        self.responses[BASE + "101/reviews?per_page=100&page=1"] = [
            self.approval, {**self.approval, "id": 2, "user": {"login": "Bob", "type": "User"}},
        ]
        self.execute("--limit", "1")
        self.assertIn("**0 of 2", self.text())

    def test_nearest_parent_specific_and_empty_mapping_entries(self):
        self.mapping.write_text("/: {RootOwner: 0.6}\n/tests/: {Alice: 0.6}\n/tests/special/: {Bob: 0.7}\n/tests/blocked/: {}\n")
        self.responses[BASE + "101"]["changed_files"] = 3
        self.responses[BASE + "101/files?per_page=100&page=1"] = [
            {"filename": "tests/new/test.py"}, {"filename": "tests/special/test.py"},
            {"filename": "tests/blocked/test.py"},
        ]
        self.execute("--limit", "1")
        self.assertIn("**1 of 3", self.text())
        self.assertIn("| <code>/tests/new/</code> | 1 | <code>/tests/</code> | Approved", self.text())
        self.assertIn("| <code>/tests/special/</code> | 1 | <code>/tests/special/</code> | Awaiting", self.text())
        self.assertIn("| <code>/tests/blocked/</code> | 1 | <code>/tests/blocked/</code> | Awaiting", self.text())

    def test_missing_mapping_and_root_fallback(self):
        self.mapping.write_text("/ansible/: {Alice: 0.6}\n")
        self.execute("--limit", "1")
        self.assertIn("No reviewer mapping", self.text())
        self.report.unlink()
        self.mapping.write_text("/: {Alice: 0.6}\n")
        self.execute("--limit", "1")
        self.assertIn("| <code>/tests/</code> | 1 | <code>/</code> | Approved", self.text())

    def test_renames_require_both_paths_and_count_once(self):
        self.responses[BASE + "101/files?per_page=100&page=1"] = [{
            "filename": "ansible/new.py", "previous_filename": "tests/old.py", "status": "renamed",
        }]
        self.execute("--limit", "1")
        self.assertIn("**0 of 1", self.text())
        self.report.unlink()
        self.responses[BASE + "101/reviews?per_page=100&page=1"].append({
            **self.approval, "id": 2, "user": {"login": "Bob", "type": "User"},
        })
        self.execute("--limit", "1")
        self.assertIn("**1 of 1", self.text())

    def test_changes_requested_or_dismissal_replaces_prior_approval(self):
        for state in ("CHANGES_REQUESTED", "DISMISSED"):
            with self.subTest(state=state):
                self.responses[BASE + "101/reviews?per_page=100&page=1"] = [
                    self.approval, {**self.approval, "id": 2, "state": state},
                ]
                self.execute("--limit", "1")
                self.assertIn("**0 of 1", self.text())
                self.report.unlink()

    def test_comment_only_review_does_not_replace_approval(self):
        self.responses[BASE + "101/reviews?per_page=100&page=1"] = [
            self.approval, {**self.approval, "id": 2, "state": "COMMENTED"},
        ]
        self.execute("--limit", "1")
        self.assertIn("**1 of 1", self.text())

    def test_submission_order_case_insensitive_reviewers_and_author_exclusion(self):
        self.responses[BASE + "101/reviews?per_page=100&page=1"] = [
            {**self.approval, "id": 9, "state": "CHANGES_REQUESTED", "submitted_at": "2020-01-01T00:00:00Z"},
            {**self.approval, "user": {"login": "ALICE", "type": "User"}},
        ]
        self.execute("--limit", "1")
        self.assertIn("**1 of 1", self.text())
        self.report.unlink()
        self.responses[BASE + "101"]["user"]["login"] = "alice"
        self.execute("--limit", "1")
        self.assertIn("**0 of 1", self.text())

    def test_bot_approval_does_not_count(self):
        self.responses[BASE + "101/reviews?per_page=100&page=1"] = [
            {**self.approval, "user": {"login": "Alice", "type": "Bot"}},
        ]
        self.execute("--limit", "1")
        self.assertIn("**0 of 1", self.text())

    def test_all_review_and_file_pages_are_read(self):
        self.responses[BASE + "101"]["changed_files"] = 101
        self.responses[BASE + "101/reviews?per_page=100&page=1"] = [
            {**self.approval, "id": i, "state": "COMMENTED"} for i in range(100)
        ]
        self.responses[BASE + "101/reviews?per_page=100&page=2"] = [self.approval]
        self.responses[BASE + "101/files?per_page=100&page=1"] = [
            {"filename": f"tests/test{i}.py"} for i in range(100)
        ]
        self.responses[BASE + "101/files?per_page=100&page=2"] = self.files
        self.execute("--limit", "1")
        self.assertIn("**101 of 101", self.text())

    def test_search_pages_advance_after_candidates_without_recent_approval(self):
        self.responses["search"] = {
            "total_count": 101, "incomplete_results": False,
            "items": [{"number": 104} for _ in range(100)],
        }
        self.responses["search"] = {"__sequence": [
            self.responses["search"],
            {"total_count": 101, "incomplete_results": False, "items": [{"number": 101}]},
        ]}
        self.execute("--limit", "1")
        self.assertIn("examined 101 candidate(s)", self.text())

    def test_no_matches_are_explicit(self):
        self.responses["search"] = {"total_count": 0, "incomplete_results": False, "items": []}
        self.execute()
        self.assertIn("No matching recent approvals found", self.text())

    def test_bad_arguments_do_not_make_api_calls(self):
        for args in (("--days", "0"), ("--days", "1.5"), ("--limit", "1001"), ("--limit", "-1"), ("--publish",), ("--days",)):
            with self.subTest(args=args):
                self.execute(*args, success=False)
        self.assertEqual(self.request_args(), [])

    def test_invalid_mapping_is_rejected_before_api_calls(self):
        for text in ("[]", "", "/tests/: [Alice]", "/tests/: {Alice: true}", "/tests/: {Alice: 2}",
                     "tests/: {Alice: 0.6}", "/tests/../: {Alice: 0.6}", "/tests/: {Alice: 0.6}\n/tests/: {}"):
            with self.subTest(text=text):
                self.mapping.write_text(text)
                self.execute(success=False)
        self.assertEqual(self.request_args(), [])

    def test_mapping_cannot_be_used_as_the_report(self):
        original = self.mapping.read_text()
        result = self.execute("--report", str(self.mapping), success=False)
        self.assertIn("must not overwrite", result.stderr)
        self.assertEqual(self.mapping.read_text(), original)

    def test_api_failure_is_reported_and_exits_nonzero(self):
        self.responses["search"] = {"__error": "GitHub unavailable"}
        self.execute(success=False)
        self.assertIn("Run failed after 0 preview(s)", self.text())
        self.assertNotIn("Run complete", self.text())

    def test_incomplete_search_and_file_list_are_not_reported_as_coverage(self):
        self.responses["search"]["incomplete_results"] = True
        self.execute(success=False)
        self.assertNotIn("## Qualified approval coverage", self.text())
        self.report.unlink()
        self.responses["search"]["incomplete_results"] = False
        self.responses[BASE + "101"]["changed_files"] = 3001
        self.execute(success=False)
        self.assertIn("Incomplete changed-file list", self.text())
        self.assertNotIn("## Qualified approval coverage", self.text())

    def test_changing_pr_does_not_append_stale_coverage(self):
        original = self.responses[BASE + "101"]
        changed = {**original, "head": {"sha": "new-head"}}
        self.responses[BASE + "101"] = {"__sequence": [original, changed]}
        self.execute(success=False)
        self.assertIn("changed during evaluation", self.text())
        self.assertNotIn("## Qualified approval coverage", self.text())

    def test_table_limit_and_escaped_paths(self):
        self.responses[BASE + "101"]["changed_files"] = 110
        self.responses[BASE + "101/files?per_page=100&page=1"] = [
            {"filename": f"tests/<script>|`{i}/test.py"} for i in range(100)
        ]
        self.responses[BASE + "101/files?per_page=100&page=2"] = [
            {"filename": f"tests/<script>|`{i}/test.py"} for i in range(100, 110)
        ]
        self.execute("--limit", "1")
        self.assertIn("**110 of 110", self.text())
        self.assertIn("Showing 100 of 110", self.text())
        self.assertIn("&lt;script&gt;&#124;&#96;", self.text())
        self.assertNotIn("<script>", self.text())


if __name__ == "__main__":
    unittest.main()
