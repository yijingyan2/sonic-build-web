const { parseCodeowners, ownersForFile, loadCodeowners } = require("../codeowners");
const { summary, parseMapping } = require("../qualified_approval_coverage");

describe("CODEOWNERS qualification", () => {
    test.each([
        ["* @Default\n/tests/ @Alice", "tests/sub/file.py", ["@Alice"]],
        ["/tests/*.py @Alice", "tests/sub/file.py", []],
        ["/tests/*.py @Alice", "tests/file.py", ["@Alice"]],
        ["/tests/ @Alice", "tests", []],
        ["/tests/**/file?.py @Alice", "tests/file1.py", ["@Alice"]],
        ["/tests/**/file?.py @Alice", "tests/sub/file1.py", ["@Alice"]],
        ["*.py @Alice", "sub/file.py", ["@Alice"]],
        ["* @Default\n/tests/ @Alice\n/tests/private.py", "tests/private.py", []],
        ["/dockers/docker-base*/ @Alice", "dockers/docker-base-bookworm/file", ["@Alice"]],
        ["/scripts @Alice", "scripts/sub/file", ["@Alice"]],
    ])("matches %s against %s", (text, filename, owners) => {
        expect(ownersForFile(filename, parseCodeowners(text))).toEqual(owners);
    });

    test("unsupported syntax is surfaced", () => {
        expect(() => parseCodeowners("* owner@example.com")).toThrow("Unsupported");
        expect(() => parseCodeowners("!private @Alice")).toThrow("Unsupported");
    });

    const pr = { head: { sha: "head" }, user: { login: "author" }, changed_files: 2 };
    const reviews = [{
        id: 1, user: { login: "alice", type: "User" }, state: "APPROVED",
        submitted_at: "2026-10-25T00:00:00Z", commit_id: "head",
    }];
    const files = [{ filename: "tests/public.py" }, { filename: "tests/private.py" }];

    test("codeowner qualifies files but not an entire partially covered folder", () => {
        const result = summary(files, parseMapping("/tests/: {Alice: 0.1}"), reviews, pr, "mapping", {
            rules: parseCodeowners("* @Alice\n/tests/private.py @Bob"), teams: {},
        });
        expect(result).toContain("**1 of 2");
        expect(result).toContain("| Awaiting qualified approval | @Alice | 0.1 | @Alice |");
    });

    test("team approval can qualify files with no reviewer mapping", () => {
        const result = summary(files, parseMapping("/other/: {}"), reviews, pr, "mapping", {
            rules: parseCodeowners("* @sonic-net/maintainers"), teams: { "sonic-net/maintainers": ["Alice"] },
        });
        expect(result).toContain("**2 of 2");
        expect(result).toContain("| Approved |");
    });

    test("stale approvals do not qualify codeowner paths", () => {
        const result = summary(files, parseMapping("/other/: {}"),
            [{ ...reviews[0], commit_id: "old-head" }], pr, "mapping", {
                rules: parseCodeowners("* @Alice"), teams: {},
            });
        expect(result).toContain("**0 of 2");
    });

    test("missing CODEOWNERS is optional but other API errors propagate", async () => {
        const octokit = { rest: { repos: { getContent: jest.fn() } } };
        octokit.rest.repos.getContent.mockRejectedValue({ status: 404 });
        await expect(loadCodeowners(octokit, "sonic-net", "repo", "base")).resolves.toEqual({ rules: [], teams: {} });
        octokit.rest.repos.getContent.mockRejectedValue(new Error("Forbidden"));
        await expect(loadCodeowners(octokit, "sonic-net", "repo", "base")).rejects.toThrow("Forbidden");
    });

    test("loads base-commit rules and paginates team membership", async () => {
        const getContent = jest.fn().mockResolvedValue({ data: {
            type: "file", encoding: "base64",
            content: Buffer.from("* @sonic-net/maintainers").toString("base64"),
        } });
        const listMembersInOrg = jest.fn();
        const octokit = {
            rest: { repos: { getContent }, teams: { listMembersInOrg } },
            paginate: jest.fn().mockResolvedValue([{ login: "Alice" }]),
        };
        const result = await loadCodeowners(octokit, "sonic-net", "repo", "base");
        expect(getContent).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "repo", ref: "base", path: ".github/CODEOWNERS",
        });
        expect(octokit.paginate).toHaveBeenCalledWith(listMembersInOrg, {
            org: "sonic-net", team_slug: "maintainers", per_page: 100,
        });
        expect(result.teams).toEqual({ "sonic-net/maintainers": ["Alice"] });
        expect(result.link).toBe("https://github.com/sonic-net/repo/blob/base/.github/CODEOWNERS");
        const comment = summary(files, parseMapping("/tests/: {}"), reviews, pr, "mapping", result);
        expect(comment).toContain("[CODEOWNERS](https://github.com/sonic-net/repo/blob/base/.github/CODEOWNERS)");
    });
});
