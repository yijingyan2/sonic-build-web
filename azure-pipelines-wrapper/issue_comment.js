const { createTokenAuth } = require("@octokit/auth-token");
const { request } = require("@octokit/request");
const { Octokit } = require("@octokit/rest");
const { execSync } = require('child_process');
require('dotenv').config();
const azp = require('./azp');
const akv = require('./keyvault');
const adoauth = require('./adoauth');
const check_run = require('./check_run');
const { retry } = require("@azure/core-amqp");

const isDevEnv = process.env.WEBHOOK_PROXY_URL ? true : false;

function init(app) {
    app.log.info("Init issue_comment!");

    app.on("issue_comment.created", async (context) => {
        var payload = context.payload;
        if ('pull_request' in payload.issue){
            issue_user_login = payload.issue.user.login;
            comment_user_login = payload.comment.user.login;
            comment_body = payload.comment.body.trim();
            command = null;

            if (comment_body.toLowerCase().startsWith('/azpw ms_conflict') ){ return };
            console.log(`issue_comment.created, ${payload.comment.id}`);
            if (isDevEnv){
                if (comment_body.toLowerCase().startsWith('/azpwd comment')){
                    await context.octokit.rest.issues.createComment({
                        owner: payload.repository.owner.login,
                        repo: payload.repository.name,
                        issue_number: payload.issue.number,
                        body: comment_body.substring(14).trim(),
                    });
                    return;
                }

                if (comment_body.toLowerCase().startsWith('/azpwd')){
                    console.log(`Comment /azpwd added: ${comment_body}`)
                    comment_body = '/azpw' + comment_body.substring(6);
                }
            }

            if (comment_body.toLowerCase().startsWith('/azpw check')){
                await check_run.create_checks_by_comment(context);
                return;
            }

            if (comment_body.toLowerCase().startsWith('/azurepipelineswrapper retry') ||
                comment_body.toLowerCase().startsWith('/azpw retry')){
                command = "Retrying failed(or canceled) jobs...";
            }
            else if (comment_body.toLowerCase().startsWith('/azurepipelineswrapper run') || 
                comment_body.toLowerCase().startsWith('/azpw run')){
                command = '⚠️ **Notice**: `/azpw run` only runs failed jobs now. If you want to trigger a whole pipline run, please rebase your branch or close and reopen the PR.\n💡 **Tip**: You can also use `/azpw retry` to retry failed jobs directly.\n\nRetrying failed(or canceled) jobs...';
            }

            if (command){
                var github_token = await akv.getGithubToken();
                const octokit = new Octokit({
                    auth: github_token,
                });
                console.log(`Creating issue comment ${command}`);
                await octokit.rest.issues.createComment({
                    owner: payload.repository.owner.login,
                    repo: payload.repository.name,
                    issue_number: payload.issue.number,
                    body: command,
                });
                await retryFailedBuilds(context);
                return;
            }
        }
  });
};

async function retryFailedBuilds(context) {
    var payload = context.payload;
    var owner = payload.repository.owner.login;
    var repo = payload.repository.name;
    var pullRequestNumber = payload.issue.number;    
    var github_token = await akv.getGithubToken();
    const octokit = new Octokit({
        auth: github_token,
    });

    // Get the PR head SHA
    var pullRequest = await context.octokit.pulls.get({
        owner: owner,
        repo: repo,
        pull_number: pullRequestNumber,
    });
    if (pullRequest.status != 200) {
        console.error(`Failed to get pull request for ${owner}/${repo}/${pullRequestNumber}`);
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: `Failed to get pull request for ${owner}/${repo}/${pullRequestNumber}.`,
        });
        return;
    }

    var headSha = pullRequest.data.head.sha;

    // List check runs from the Azure Pipelines GitHub app
    var checkRunsResponse = await context.octokit.checks.listForRef({
        owner: owner,
        repo: repo,
        ref: headSha,
        app_id: process.env.AZP_APP_ID,
    });
    if (checkRunsResponse.status != 200) {
        console.error(`Failed to list check runs for ${owner}/${repo}/${headSha}`);
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: `Failed to fetch pipeline information. Please close and reopen the PR or rebase your branch to trigger a new pipeline.`,
        });
        return;
    }

    var latestBuild = null;
    var latestStartedAt = null;
    for (var cr of checkRunsResponse.data.check_runs) {
        var info = azp.getAzDevInfoFromCheckPayload(cr);
        if (info && info.buildId) {
            var startedAt = cr.started_at ? new Date(cr.started_at) : new Date(0);
            if (!latestBuild || startedAt > latestStartedAt) {
                latestBuild = info;
                latestStartedAt = startedAt;
            }
        }
    }

    if (!latestBuild) {
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: `No Azure DevOps builds found for ${owner}/${repo}#${pullRequestNumber}.`,
        });
        return;
    }

    var az_token = await adoauth.getAdoAadToken();

    var timelineUrl = `https://dev.azure.com/${latestBuild.org}/${latestBuild.projectId}/_apis/build/builds/${latestBuild.buildId}/timeline?api-version=7.1`;
    var timelineCmd = `curl --silent --show-error --request GET --url "${timelineUrl}" --header "Authorization: Bearer ${az_token}" --header "Content-Type: application/json"`;
    var timelineOutput = execSync(timelineCmd, { encoding: 'utf-8' });
    var timeline;
    try {
        timeline = JSON.parse(timelineOutput);
    } catch (e) {
        console.error(`Failed to parse timeline for build ${latestBuild.buildId}: ${e.message}`);
        return;
    }

    if (!timeline || !timeline.records) {
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: `Build not found. Please close and reopen the PR or rebase your branch to trigger a new build.`,
        });
        return;
    }

    var failedStages = [], failedJobs = [], inProgressStages = [];
    for (var record of timeline.records) {
        if (record.type === 'Stage' &&
            (record.result === 'failed' || record.result === 'canceled')) {
            failedStages.push(record);
        }
        if (record.type === 'Job' &&
            (record.result === 'failed' || record.result === 'canceled')) {
            failedJobs.push(record);
        }
        if (record.type === 'Stage' && record.state === 'inProgress') {
            inProgressStages.push(record);
        }
    }

    if (failedStages.length === 0 && failedJobs.length === 0) {
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: `No failed(or canceled) stages or jobs found in the most recent build ${latestBuild.buildId}.`,
        });
        return;
    }
    
    if (failedStages.length == 0 && failedJobs.length > 0 && inProgressStages.length > 0){
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: `No failed(or canceled) jobs found in completed stages. Only failed(or canceled) jobs in completed stages can be retried.\n\nStages in progress: ${inProgressStages.map(s => s.name).join(', ')}. Please wait for the stages to complete and then retry again.`,
        });
        return;
    }

    if (failedStages.length == 0 && failedJobs.length > 0){
        var comment_body = `The following failed(or canceled) jobs were not retried:\n`;
        comment_body += failedJobs.map(j => `- ${j.name}`).join('\n');
        for (var job of failedJobs) {
            if (job.name === 'Cancel previous test plans for same PR' || job.name.includes('[OPTIONAL]') || job.name.includes('vulnerability scan')) {
                comment_body += `\n\nJob ${job.name} is an optional job and does not block the PR merge, so it will not be retried.`;
            }
        }
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: comment_body,
        });
        return;
    }

    // Retry each failed stage individually
    var summaryLines = [`Retrying failed(or canceled) stages in build ${latestBuild.buildId}:`];
    var data = JSON.stringify({ state: 1, forceRetryAllJobs: false, retryDependencies: true });
    for (var stage of failedStages) {
        try {
            var url = `https://dev.azure.com/${latestBuild.org}/${latestBuild.projectId}/_apis/build/builds/${latestBuild.buildId}/stages/${stage.identifier}?api-version=7.1`;
            var cmd = `curl --silent --show-error --request PATCH --url "${url}" --header "Authorization: Bearer ${az_token}" --header "Content-Type: application/json" --data '${data}'`;
            var output = execSync(cmd, { encoding: 'utf-8' });
            console.log(`Retried stage '${stage.identifier}' in build ${latestBuild.buildId}: ${output}`);
            summaryLines.push(`\n\n✅Stage **${stage.identifier}**:`);
            for (var job of failedJobs.filter(j => j.identifier.startsWith(stage.identifier))) {
                if (job.name === 'Cancel previous test plans for same PR' || job.name.includes('[OPTIONAL]') || job.name.includes('vulnerability scan')) {
                    summaryLines.push(`- Job ${job.name}: skipped (optional job and does not block the PR merge).`);
                } else {
                    summaryLines.push(`- Job ${job.name}: retried.`);
                }
            }
        } catch (e) {
            console.error(`Failed to retry stage '${stage.identifier}' in build ${latestBuild.buildId}: ${e.message}`);
            summaryLines.push(`❌ Stage **${stage.identifier}**: error — ${e.message}`);
        }
    }

    await octokit.rest.issues.createComment({
        owner: owner,
        repo: repo,
        issue_number: pullRequestNumber,
        body: summaryLines.join('\n'),
    });
}

module.exports = Object.freeze({
    init: init,
});
