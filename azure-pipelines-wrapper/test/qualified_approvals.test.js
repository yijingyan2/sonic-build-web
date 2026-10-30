const mockEnqueueAction = jest.fn();
const mockGetGithubToken = jest.fn();
const mockOctokit = jest.fn();
jest.mock("../action_queue", () => ({ enqueueAction: mockEnqueueAction }));
jest.mock("../keyvault", () => ({ getGithubToken: mockGetGithubToken }));
jest.mock("@octokit/rest", () => ({
    Octokit: jest.fn(function (options) { return mockOctokit(options); }),
}));
const qualifiedApprovals = require("../qualified_approvals");

const marker = "<!-- sonic-qualified-approval-coverage -->";
const mappingText = `/: {RootOwner: 0.6}
/tests/: {Alice: 0.5, Bob: 0.7}
/tests/special/: {Carol: 0.6}
/tests/blocked/: {}
/ansible/: {Bob: 0.5}
`;
const review = (login, state = "APPROVED", commit = "head", id = 1) => ({
    id, user: { login, type: "User" }, state, commit_id: commit,
    submitted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
});

describe("qualified approval coverage", () => {
    let octokit;
    let pr;
    let source;
    let files;
    let reviews;
    let comments;
    let collaborators;

    beforeEach(() => {
        jest.clearAllMocks();
        pr = {
            state: "open", number: 42, head: { sha: "head" }, base: { sha: "base" },
            user: { login: "author" }, changed_files: 1, labels: [],
        };
        source = {
            type: "file", encoding: "base64",
            content: Buffer.from(mappingText).toString("base64"),
        };
        files = [{ filename: "tests/test_one.py", status: "modified" }];
        reviews = [];
        comments = [];
        collaborators = [{ login: "Alice", type: "User" }, { login: "Bob", type: "User" }];
        const pulls = {
            get: jest.fn(async () => ({ data: pr })),
            listFiles: jest.fn(), listReviews: jest.fn(),
            requestReviewers: jest.fn().mockResolvedValue({}),
        };
        const issues = {
            listComments: jest.fn(),
            createComment: jest.fn().mockResolvedValue({}),
            updateComment: jest.fn().mockResolvedValue({}),
            addLabels: jest.fn(async ({ labels }) => {
                pr.labels.push(...labels.map(name => ({ name })));
            }),
            removeLabel: jest.fn(async ({ name }) => {
                pr.labels = pr.labels.filter(label => label.name !== name);
            }),
        };
        octokit = {
            rest: {
                pulls, issues,
                repos: { listCollaborators: jest.fn(), getContent: jest.fn(async params => {
                    if (params.path === ".github/CODEOWNERS") {
                        throw Object.assign(new Error("Not found"), { status: 404 });
                    }
                    return { data: source };
                }) },
            },
            paginate: jest.fn(async method => {
                if (method === pulls.listFiles) return files;
                if (method === pulls.listReviews) return reviews;
                if (method === issues.listComments) return comments;
                if (method === octokit.rest.repos.listCollaborators) return collaborators;
                throw new Error("Unexpected pagination method");
            }),
        };
        mockOctokit.mockReturnValue(octokit);
        mockGetGithubToken.mockResolvedValue("bot-token");
        mockEnqueueAction.mockReset();
    });

    const sync = () => qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42);
    const body = () => octokit.rest.issues.createComment.mock.calls[0][0].body;
    const noComment = () => {
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
        expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    };

    test("assignment requests qualified reviewers without reading or writing comments", async () => {
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true);
        expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-mgmt", pull_number: 42,
            reviewers: expect.arrayContaining(["alice", "bob"]), team_reviewers: [],
        });
        noComment();
        expect(octokit.paginate).not.toHaveBeenCalledWith(
            octokit.rest.issues.listComments, expect.anything(),
        );
    });

    test("does not re-request outstanding reviewers", async () => {
        pr.requested_reviewers = [{ login: "Alice" }, { login: "Bob" }, { login: "Existing" }];
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true);
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        noComment();
    });

    test("filters non-collaborators before requesting reviewers", async () => {
        collaborators = [{ login: "Bob", type: "User" }];
        const log = { info: jest.fn(), warn: jest.fn() };
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true, log);
        expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalledWith(expect.objectContaining({
            reviewers: ["bob"], team_reviewers: [],
        }));
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("excluded non-collaborators: alice"));
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("review requests accepted"));
        noComment();
    });

    test("surfaces eligibility lookup failures without requesting reviewers", async () => {
        octokit.paginate.mockImplementation(async method => {
            if (method === octokit.rest.repos.listCollaborators) throw new Error("Cannot list collaborators");
            if (method === octokit.rest.pulls.listFiles) return files;
            if (method === octokit.rest.pulls.listReviews) return reviews;
            throw new Error("Unexpected pagination method");
        });
        await expect(qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true))
            .rejects.toThrow("Cannot list collaborators");
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        noComment();
    });

    test("does not assign drafts", async () => {
        pr.draft = true;
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true);
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        noComment();
    });

    test("assignment failures propagate without claiming success", async () => {
        octokit.rest.pulls.requestReviewers.mockRejectedValue(new Error("Cannot request reviewer"));
        const log = { info: jest.fn(), warn: jest.fn() };
        await expect(qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true, log))
            .rejects.toThrow("Cannot request reviewer");
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("reviewers="));
        const selection = log.info.mock.calls[0][0];
        expect(selection).toContain('"alice"');
        expect(selection).toContain('"bob"');
        expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("review requests accepted"));
        noComment();
    });

    test("reports approval and pending coverage from multiple qualified users", async () => {
        files.push({ filename: "ansible/task.yml" }, { filename: "tests/special/test_two.py" });
        pr.changed_files = 3;
        reviews = [review("alice"), review("BOB", "APPROVED", "head", 2)];
        await sync();
        expect(body()).toContain("**2 of 3 changed files have qualified approval**");
        expect(body()).toContain("| <code>/tests/</code> | 1 | <code>/tests/</code> | Approved | @Alice, @Bob |");
        expect(body()).toContain("| <code>/ansible/</code> | 1 | <code>/ansible/</code> | Approved | @Bob |");
        expect(body()).toContain("| <code>/tests/special/</code> | 1 | <code>/tests/special/</code> | Awaiting qualified approval | - |");
        expect(body()).toContain("[Reviewer mapping](https://github.com/sonic-net/sonic-tsc/blob/master/pr_reviewer/sonic-mgmt/pr_reviewer-by-files.yml)");
        expect(body()).toContain("does not yet meet the qualified-approval requirement for auto-merge");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    test("labels complete coverage and announces the auto-merge approval requirement", async () => {
        reviews = [review("Alice")];
        await sync();
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-mgmt", issue_number: 42, labels: ["Qualified-approval"],
        });
        expect(body()).toContain("**All changed folders have qualified approval.**");
        expect(body()).toContain("meets the qualified-approval requirement for auto-merge");
        expect(body()).toContain("including required checks, branch protection");
        expect(body()).toContain("does not enable auto-merge or merge the PR");
        await sync();
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
    });

    test("preserves existing matching labels regardless of case", async () => {
        pr.labels = [{ name: "qualified-approval" }, { name: "unrelated" }];
        reviews = [review("Alice")];
        await sync();
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    });

    test("does not qualify an empty PR", async () => {
        files = [];
        pr.changed_files = 0;
        await sync();
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(body()).not.toContain("**All changed folders have qualified approval.**");
    });

    test("removes a stale label on synchronize even if reviewer access lookup fails", async () => {
        pr.labels = [{ name: "Qualified-approval" }, { name: "unrelated" }];
        reviews = [review("Alice", "APPROVED", "previous-head")];
        const paginate = octokit.paginate.getMockImplementation();
        octokit.paginate.mockImplementation(async (method, params) => {
            if (method === octokit.rest.repos.listCollaborators) throw new Error("Cannot list collaborators");
            return paginate(method, params);
        });
        await expect(qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true))
            .rejects.toThrow("Cannot list collaborators");
        expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-mgmt", issue_number: 42, name: "Qualified-approval",
        });
        expect(pr.labels).toEqual([{ name: "unrelated" }]);
        noComment();
    });

    test.each(["addLabels", "removeLabel"])("surfaces %s failures without a misleading comment", async method => {
        if (method === "addLabels") reviews = [review("Alice")];
        else pr.labels = [{ name: "Qualified-approval" }];
        octokit.rest.issues[method].mockRejectedValue(new Error("Cannot update label"));
        await expect(sync()).rejects.toThrow("Cannot update label");
        noComment();
    });

    test("loads only the trusted master mapping and paginates every collection", async () => {
        await sync();
        expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-tsc", ref: "master",
            path: "pr_reviewer/sonic-mgmt/pr_reviewer-by-files.yml",
        });
        expect(octokit.paginate).toHaveBeenCalledTimes(2);
        for (const [, params] of octokit.paginate.mock.calls) {
            expect(params.per_page).toBe(100);
        }
    });

    test.each([
        [0.2, 0.19, false],
        [0.2, 0.2, true],
        [0.2, 0.2001, true],
        [0.4, 0, true],
        [0.4001, 0, true],
    ])("qualifies when approver scores %s + %s reach 0.4", async (alice, bob, qualified) => {
        source.content = Buffer.from(`/tests/: {Alice: ${alice}, Bob: ${bob}}`).toString("base64");
        reviews = [review("Alice"), review("BOB", "APPROVED", "head", 2)];
        await sync();
        expect(body()).toContain(`**${qualified ? 1 : 0} of 1`);
        expect(body()).toContain(`| ${qualified ? "Approved" : "Awaiting qualified approval"} | @Alice, @Bob |`);
        expect(body()).toContain("exactly 0.4 qualifies");
    });

    test("counts each active mapped approver once and excludes inactive and unmapped scores", async () => {
        source.content = Buffer.from("/tests/: {Alice: 0.2, Bob: 0.3, Carol: 0.3, author: 0.9}").toString("base64");
        reviews = [
            review("Alice"), review("alice", "APPROVED", "head", 2),
            review("Bob", "APPROVED", "old-head", 3),
            review("Carol", "APPROVED", "head", 4), review("Carol", "DISMISSED", "head", 5),
            review("author", "APPROVED", "head", 6), review("Unmapped", "APPROVED", "head", 7),
        ];
        await sync();
        expect(body()).toContain("**0 of 1");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(body()).toContain("| Awaiting qualified approval | @Alice | 0.2 |");
    });

    test("does not pool approver scores across folders", async () => {
        source.content = Buffer.from("/tests/: {Alice: 0.3}\n/ansible/: {Bob: 0.3}").toString("base64");
        files.push({ filename: "ansible/task.yml" });
        pr.changed_files = 2;
        reviews = [review("Alice"), review("Bob", "APPROVED", "head", 2)];
        await sync();
        expect(body()).toContain("**0 of 2");
    });

    test("decimal scores totaling exactly 0.4 qualify", async () => {
        const users = Array.from({ length: 40 }, (_, i) => `Reviewer${i}`);
        source.content = Buffer.from(`/tests/: {${users.map(login => `${login}: 0.01`).join(", ")}}`).toString("base64");
        reviews = users.map((login, i) => review(login, "APPROVED", "head", i + 1));
        await sync();
        expect(body()).toContain("**1 of 1");
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
        expect(body()).toContain("| 0.4 |");
    });

    test("inherits the nearest parent mapping, but not beyond a specific entry", async () => {
        files = [
            { filename: "tests/new/deeper/file.py" },
            { filename: "tests/special/deeper/file.py" },
            { filename: "tests/blocked/file.py" },
        ];
        pr.changed_files = 3;
        reviews = [review("Alice"), review("RootOwner", "APPROVED", "head", 2)];
        await sync();
        expect(body()).toContain("**1 of 3");
        expect(body()).toContain("| <code>/tests/new/deeper/</code> | 1 | <code>/tests/</code> | Approved");
        expect(body()).toContain("| <code>/tests/blocked/</code> | 1 | <code>/tests/blocked/</code> | Awaiting");
    });

    test("uses the root mapping for root files and unmapped descendants", async () => {
        files = [{ filename: "README.md" }, { filename: "new/file.txt" }];
        pr.changed_files = 2;
        reviews = [review("RootOwner")];
        await sync();
        expect(body()).toContain("**2 of 2");
        expect(body()).toContain("| <code>/</code> | 1 | <code>/</code> | Approved");
    });

    test("distinguishes absent mappings from pending approval", async () => {
        source.content = Buffer.from("/ansible/: {Bob: 0.5}").toString("base64");
        reviews = [review("Bob")];
        await sync();
        expect(body()).toContain("**0 of 1");
        expect(body()).toContain("| <code>/tests/</code> | 1 | - | No reviewer mapping | - |");
    });

    test.each(["old-head", null])("does not count approval for commit %s", async commit => {
        reviews = [review("Alice", "APPROVED", commit)];
        await sync();
        expect(body()).toContain("**0 of 1");
    });

    test.each(["CHANGES_REQUESTED", "DISMISSED"])("revokes earlier approvals after %s", async state => {
        reviews = [review("alice", state, "head", 9), review("Alice", "APPROVED", "head", 2)];
        await sync();
        expect(body()).toContain("**0 of 1");
    });

    test.each(["COMMENTED", "PENDING"])("does not replace approval with a %s review", async state => {
        reviews = [review("Alice"), review("alice", state, "head", 2)];
        await sync();
        expect(body()).toContain("**1 of 1");
    });

    test("a newer approval replaces changes requested", async () => {
        reviews = [review("Alice", "CHANGES_REQUESTED"), review("alice", "APPROVED", "head", 2)];
        await sync();
        expect(body()).toContain("**1 of 1");
    });

    test("uses submission time rather than review creation order", async () => {
        const approval = review("Alice", "APPROVED", "head", 1);
        approval.submitted_at = "2026-02-01T00:00:00Z";
        reviews = [review("Alice", "CHANGES_REQUESTED", "head", 2), approval];
        await sync();
        expect(body()).toContain("**1 of 1");
    });

    test("rejects decisive reviews with missing submission timestamps", async () => {
        reviews = [{ ...review("Alice"), submitted_at: null }];
        await expect(sync()).rejects.toThrow("submission time");
        noComment();
    });

    test.each(["author", "bot", "unqualified"])("excludes %s approvals", async kind => {
        const user = review(kind === "unqualified" ? "Stranger" : "Alice");
        if (kind === "author") pr.user.login = "ALICE";
        if (kind === "bot") user.user.type = "Bot";
        reviews = [user];
        await sync();
        expect(body()).toContain("**0 of 1");
    });

    test.each(["removed", "added"])("includes %s files", async status => {
        files[0].status = status;
        reviews = [review("Alice")];
        await sync();
        expect(body()).toContain("**1 of 1");
    });

    test("renames require old and new path coverage without double-counting", async () => {
        files = [{
            filename: "ansible/renamed.py", previous_filename: "tests/original.py", status: "renamed",
        }];
        reviews = [review("Alice")];
        await sync();
        expect(body()).toContain("**0 of 1");
        reviews.push(review("Bob", "APPROVED", "head", 2));
        octokit.rest.issues.createComment.mockClear();
        await sync();
        expect(body()).toContain("**1 of 1");
    });

    test("posts new coverage snapshots even when an identical previous comment exists", async () => {
        await sync();
        const original = body();
        comments = [
            { id: 10, user: { login: "someone" }, body: original },
            { id: 11, user: { login: "mssonicbld" }, body: "Other bot comment" },
            { id: 12, user: { login: "mssonicbld" }, body: original },
        ];
        octokit.rest.issues.createComment.mockClear();
        await sync();
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
        expect(body()).toBe(original);
        reviews = [review("Alice")];
        await sync();
        expect(octokit.rest.issues.createComment).toHaveBeenLastCalledWith({
            owner: "sonic-net", repo: "sonic-mgmt", issue_number: 42,
            body: expect.stringContaining("**1 of 1"),
        });
        expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
        expect(octokit.paginate).not.toHaveBeenCalledWith(octokit.rest.issues.listComments, expect.anything());
    });

    test("does not trust another user's marked comment", async () => {
        comments = [{ id: 10, user: { login: "someone" }, body: marker }];
        await sync();
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
        expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    });

    test.each([
        "", "[]", "/tests/: [Alice]", "/tests/: {Alice: bad}", "/tests/: {Alice: 2}",
        "/tests/: {Alice: -1}", "tests/: {Alice: 0.6}", "/tests/../: {Alice: 0.6}",
        "/tests/: {'<invalid>': 0.6}", "/tests/: {Alice: 0.6}\n/tests/: {Bob: 0.5}",
    ])("surfaces malformed mapping %s without publishing", async text => {
        source.content = Buffer.from(text).toString("base64");
        await expect(sync()).rejects.toThrow();
        noComment();
    });

    test("surfaces unavailable mapping rather than reporting false coverage", async () => {
        octokit.rest.repos.getContent.mockRejectedValue(new Error("Mapping not found"));
        await expect(sync()).rejects.toThrow("Mapping not found");
        noComment();
    });

    test("rejects unsupported mapping response formats", async () => {
        source.encoding = "none";
        await expect(sync()).rejects.toThrow("not a readable file");
        noComment();
    });

    test("rejects truncated GitHub file lists", async () => {
        pr.changed_files = 3001;
        await expect(sync()).rejects.toThrow("Incomplete changed-file list");
        noComment();
    });

    test("surfaces file-list API failures", async () => {
        octokit.paginate.mockRejectedValue(new Error("GitHub unavailable"));
        await expect(sync()).rejects.toThrow("GitHub unavailable");
        noComment();
    });

    test.each(["head", "base", "closed"])("avoids publishing after PR %s changes", async change => {
        const current = { ...pr, head: { ...pr.head }, base: { ...pr.base } };
        if (change === "closed") current.state = "closed";
        else current[change].sha = "new-sha";
        octokit.rest.pulls.get.mockResolvedValueOnce({ data: pr }).mockResolvedValueOnce({ data: current });
        await expect(sync()).rejects.toThrow("skipping stale summary");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
        noComment();
    });

    test("skips closed PRs", async () => {
        pr.state = "closed";
        await sync();
        expect(octokit.paginate).not.toHaveBeenCalled();
        noComment();
    });

    test("limits table size but counts every changed file", async () => {
        files = Array.from({ length: 110 }, (_, i) => ({ filename: `tests/sub${i}/file.py` }));
        pr.changed_files = files.length;
        reviews = [review("Alice")];
        await sync();
        expect(body()).toContain("**110 of 110");
        expect(body()).toContain("Showing 100 of 110 changed folders");
        expect(body().split("\n").filter(line => line.startsWith("| <code>"))).toHaveLength(100);
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
    });

    test("does not label partial coverage hidden beyond the displayed folder limit", async () => {
        files = Array.from({ length: 100 }, (_, i) => ({ filename: `tests/sub${i}/file.py` }));
        files.push({ filename: "zzz/unmapped.py" });
        pr.changed_files = files.length;
        reviews = [review("Alice")];
        await sync();
        expect(body()).toContain("**100 of 101");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    test("escapes folder paths in comment tables", async () => {
        files[0].filename = "tests/<script>|`/file.py";
        await sync();
        expect(body()).toContain("&lt;script&gt;&#124;&#96;");
        expect(body()).not.toContain("<script>");
    });

    test("reports API comment-write failures", async () => {
        octokit.rest.issues.createComment.mockRejectedValue(new Error("Cannot comment"));
        await expect(sync()).rejects.toThrow("Cannot comment");
    });

    test("queues review and PR updates using the bot token", async () => {
        const app = { on: jest.fn() };
        qualifiedApprovals.init(app);
        const [events, handler] = app.on.mock.calls[0];
        expect(events).toEqual(expect.arrayContaining([
            "pull_request_review.submitted",
            "pull_request_review.dismissed",
            "pull_request.synchronize", "pull_request.edited",
        ]));
        await handler({ payload: {
            repository: { full_name: "sonic-net/sonic-mgmt", owner: { login: "sonic-net" }, name: "sonic-mgmt" },
            pull_request: pr, action: "submitted", review: { state: "approved" },
        } });
        expect(mockEnqueueAction).toHaveBeenCalledWith(
            expect.any(Function), "qualified approvals sonic-net/sonic-mgmt#42", app,
        );
        await mockEnqueueAction.mock.calls[0][0]();
        expect(mockOctokit).toHaveBeenCalledWith({ auth: "bot-token" });
        expect(body()).toContain(marker);
        expect(body()).not.toContain("## Reviewer assignment");
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
    });

    test("ignores comment-only reviews", async () => {
        const app = { on: jest.fn() };
        qualifiedApprovals.init(app);
        await app.on.mock.calls[0][1]({ payload: {
            repository: { full_name: "sonic-net/sonic-mgmt" },
            pull_request: pr, action: "submitted",
            review: { state: "commented" },
        } });
        expect(mockEnqueueAction).not.toHaveBeenCalled();
    });

    test.each(["changes_requested", "dismissed"])("updates only labels on %s reviews", async state => {
        pr.labels = [{ name: "Qualified-approval" }];
        reviews = [review("Alice"), review("Alice", state.toUpperCase(), "head", 2)];
        const app = { on: jest.fn() };
        qualifiedApprovals.init(app);
        await app.on.mock.calls[0][1]({ payload: {
            repository: { full_name: "sonic-net/sonic-mgmt", owner: { login: "sonic-net" }, name: "sonic-mgmt" },
            pull_request: pr, action: state === "dismissed" ? "dismissed" : "submitted",
            review: { state },
        } });
        await mockEnqueueAction.mock.calls[0][0]();
        expect(octokit.rest.issues.removeLabel).toHaveBeenCalledTimes(1);
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        expect(octokit.paginate).not.toHaveBeenCalledWith(octokit.rest.repos.listCollaborators, expect.anything());
        noComment();
    });

    test("keeps the label when another approver still covers a dismissed approval", async () => {
        pr.labels = [{ name: "Qualified-approval" }];
        reviews = [review("Alice", "DISMISSED"), review("Bob", "APPROVED", "head", 2)];
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, false, console, false);
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
        noComment();
    });

    test.each(["opened", "reopened", "ready_for_review", "synchronize", "edited"])(
        "assigns silently on %s events", async action => {
            const app = { on: jest.fn() };
            qualifiedApprovals.init(app);
            await app.on.mock.calls[0][1]({ payload: {
                repository: { full_name: "sonic-net/sonic-mgmt", owner: { login: "sonic-net" }, name: "sonic-mgmt" },
                pull_request: pr, action, changes: { base: {} },
            } });
            await mockEnqueueAction.mock.calls[0][0]();
            expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalled();
            noComment();
        },
    );

    test.each(["unlisted", "closed", "body-edit"])("ignores %s events", async kind => {
        const app = { on: jest.fn() };
        qualifiedApprovals.init(app);
        if (kind === "closed") pr.state = "closed";
        await app.on.mock.calls[0][1]({ payload: {
            repository: { full_name: kind === "unlisted" ? "someone/sonic-mgmt" : "sonic-net/sonic-mgmt" },
            pull_request: pr, action: kind === "body-edit" ? "edited" : "submitted",
            changes: { body: {} },
        } });
        expect(mockEnqueueAction).not.toHaveBeenCalled();
    });
});
