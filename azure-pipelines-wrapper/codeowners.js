function parseCodeowners(text) {
    return text.split(/\r?\n/).flatMap((line, index) => {
        const fields = line.replace(/#.*$/, "").trim().split(/\s+/);
        const pattern = fields.shift();
        if (!pattern) return [];
        if (/[!\\[\]]/.test(pattern) ||
            fields.some(owner => !/^@[a-z\d-]+(?:\/[a-z\d_-]+)?$/i.test(owner))) {
            throw new Error(`Unsupported CODEOWNERS syntax on line ${index + 1}`);
        }
        const glob = pattern.replace(/^\//, "").replace(/\/$/, "");
        let expression = "";
        for (let i = 0; i < glob.length; i += 1) {
            if (glob[i] === "*" && glob[i + 1] === "*") {
                if (glob[i + 2] === "/") {
                    expression += "(?:.*/)?";
                    i += 2;
                } else {
                    expression += ".*";
                    i += 1;
                }
            } else if (glob[i] === "*") expression += "[^/]*";
            else if (glob[i] === "?") expression += "[^/]";
            else expression += glob[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        const prefix = pattern.startsWith("/") || glob.includes("/") ? "^" : "(?:^|/)";
        const suffix = pattern.endsWith("/") ? "/.*$" : "(?:/.*)?$";
        return [{ pattern, owners: fields, regex: new RegExp(`${prefix}${expression}${suffix}`) }];
    });
}

function ownersForFile(filename, rules) {
    let owners = [];
    for (const rule of rules) {
        if (rule.regex.test(filename)) owners = rule.owners;
    }
    return owners;
}

function approvedOwners(filename, rules, approvers, teams) {
    return ownersForFile(filename, rules).filter(owner => {
        const name = owner.slice(1).toLowerCase();
        return name.includes("/")
            ? (teams[name] || []).some(login => approvers.has(login.toLowerCase()))
            : approvers.has(name);
    });
}

async function loadCodeowners(octokit, owner, repo, ref) {
    let source;
    try {
        ({ data: source } = await octokit.rest.repos.getContent({
            owner, repo, ref, path: ".github/CODEOWNERS",
        }));
    } catch (error) {
        if (error.status === 404) return { rules: [], teams: {} };
        throw error;
    }
    if (source.type !== "file" || source.encoding !== "base64" || !source.content) {
        throw new Error("CODEOWNERS is not a readable file");
    }
    const rules = parseCodeowners(Buffer.from(source.content, "base64").toString("utf8"));
    const teams = {};
    for (const name of new Set(rules.flatMap(rule => rule.owners)
        .map(login => login.slice(1).toLowerCase()).filter(login => login.includes("/")))) {
        const [org, team_slug] = name.split("/");
        const members = await octokit.paginate(octokit.rest.teams.listMembersInOrg, {
            org, team_slug, per_page: 100,
        });
        teams[name] = members.map(member => member.login);
    }
    return {
        rules, teams,
        link: `https://github.com/${owner}/${repo}/blob/${ref}/.github/CODEOWNERS`,
    };
}

module.exports = Object.freeze({ parseCodeowners, ownersForFile, approvedOwners, loadCodeowners });
