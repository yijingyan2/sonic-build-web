const { loadReviewerAccess } = require("../reviewer_access");
const { planAssignments } = require("../reviewer_assignment");
const { parseCodeowners } = require("../codeowners");

describe("repository reviewer eligibility", () => {
    let octokit;
    let log;

    beforeEach(() => {
        octokit = {
            rest: {
                repos: { listCollaborators: jest.fn() },
                teams: { checkPermissionsForRepoInOrg: jest.fn().mockResolvedValue({}) },
            },
            paginate: jest.fn().mockResolvedValue([
                { login: "Alice", type: "User" }, { login: "Robot", type: "Bot" },
            ]),
        };
        log = { info: jest.fn(), warn: jest.fn() };
    });

    test("paginates collaborators and checks repository permissions for teams", async () => {
        const access = await loadReviewerAccess(octokit, "sonic-net", "repo", {
            teams: { "sonic-net/owners": ["Alice"], "elsewhere/owners": ["Alice"] },
        }, log);
        expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.repos.listCollaborators, {
            owner: "sonic-net", repo: "repo", per_page: 100,
        });
        expect(access.users).toEqual(new Set(["alice"]));
        expect(access.teams).toEqual(new Set(["sonic-net/owners"]));
        expect(octokit.rest.teams.checkPermissionsForRepoInOrg).toHaveBeenCalledTimes(1);
        expect(octokit.rest.teams.checkPermissionsForRepoInOrg).toHaveBeenCalledWith({
            org: "sonic-net", team_slug: "owners", owner: "sonic-net", repo: "repo",
        });
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("elsewhere/owners"));
    });

    test("excludes teams with no repository permission", async () => {
        octokit.rest.teams.checkPermissionsForRepoInOrg.mockRejectedValue({ status: 404 });
        const access = await loadReviewerAccess(octokit, "sonic-net", "repo", {
            teams: { "sonic-net/owners": ["Alice"] },
        }, log);
        expect(access.teams.size).toBe(0);
        expect(log.warn).toHaveBeenCalled();
    });

    test.each([403, 500])("propagates team permission lookup errors with status %s", async status => {
        const error = Object.assign(new Error("Cannot check team access"), { status });
        octokit.rest.teams.checkPermissionsForRepoInOrg.mockRejectedValue(error);
        await expect(loadReviewerAccess(octokit, "sonic-net", "repo", {
            teams: { "sonic-net/owners": ["Alice"] },
        }, log)).rejects.toBe(error);
    });

    test("falls back from inaccessible codeowner to an eligible mapped user", () => {
        const plan = planAssignments(
            [{ filename: "tests/file.py" }], { "/tests/": { Alice: 0.4, Stranger: 0.9 } }, [],
            { changed_files: 1, head: { sha: "head" }, user: { login: "author" } },
            { rules: parseCodeowners("* @Stranger @sonic-net/owners"), teams: { "sonic-net/owners": ["Alice"] } },
            () => 0, { users: new Set(["alice"]), teams: new Set() },
        );
        expect(plan.reviewers).toEqual(["alice"]);
        expect(plan.team_reviewers).toEqual([]);
        expect(plan.excluded).toEqual(["stranger"]);
        expect(plan.requestedTotal).toBe(1);
    });

    test("returns no reviewers when every candidate lacks repository access", () => {
        const plan = planAssignments(
            [{ filename: "tests/file.py" }], { "/tests/": { Stranger: 0.9 } }, [],
            { changed_files: 1, head: { sha: "head" }, user: { login: "author" } },
            { rules: [], teams: {} }, () => 0, { users: new Set(), teams: new Set() },
        );
        expect(plan.reviewers).toEqual([]);
        expect(plan.rows[0].reviewer).toBeUndefined();
    });

    test("requests an eligible team as a team rather than an individual", () => {
        const plan = planAssignments(
            [{ filename: "tests/file.py" }], {}, [],
            { changed_files: 1, head: { sha: "head" }, user: { login: "author" } },
            { rules: parseCodeowners("* @sonic-net/owners"), teams: { "sonic-net/owners": ["Alice"] } },
            () => 0, { users: new Set(["alice"]), teams: new Set(["sonic-net/owners"]) },
        );
        expect(plan.reviewers).toEqual([]);
        expect(plan.team_reviewers).toEqual(["owners"]);
    });
});
