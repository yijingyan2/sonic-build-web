async function loadReviewerAccess(octokit, owner, repo, codeowners, log) {
    const collaborators = await octokit.paginate(octokit.rest.repos.listCollaborators, {
        owner, repo, per_page: 100,
    });
    const users = new Set(collaborators.filter(user => user.type !== "Bot")
        .map(user => user.login.toLowerCase()));
    const teams = new Set();
    for (const name of Object.keys(codeowners.teams)) {
        const [org, team_slug] = name.split("/");
        if (org !== owner.toLowerCase()) {
            log.warn(`[ REVIEWER ASSIGNMENT ] Excluding team ${name}: not in repository organization`);
            continue;
        }
        try {
            await octokit.rest.teams.checkPermissionsForRepoInOrg({ org, team_slug, owner, repo });
            teams.add(name);
        } catch (error) {
            if (error.status !== 404) throw error;
            log.warn(`[ REVIEWER ASSIGNMENT ] Excluding team ${name}: repository access not found`);
        }
    }
    return { users, teams };
}

module.exports = Object.freeze({ loadReviewerAccess });
