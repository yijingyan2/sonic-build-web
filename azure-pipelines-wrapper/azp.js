const azdev=require("azure-devops-node-api");
const azbuild=require("azure-devops-node-api/BuildApi");
require('dotenv').config();
const akv = require('./keyvault.js');
const adoauth = require('./adoauth.js');
const detail_url_prefix = 'https://dev.azure.com/';

async function getconnection(org){
    var orgUrl = "https://dev.azure.com/" + org;
    var token = await adoauth.getAdoAadToken();
    var authHandler = azdev.getBearerHandler(token);
    var connection = new azdev.WebApi(orgUrl, authHandler);
    return connection;
}

function getAzDevInfoFromCheckPayload(check_run){
    if ('details_url' in check_run && 'external_id' in check_run){
        var details_url = check_run.details_url;
        if (check_run.details_url.startsWith(detail_url_prefix)){
            var org = check_run.details_url.substring(detail_url_prefix.length).split("/")[0];
            var external_ids = check_run.external_id.split('|');
            return {
                org: org,
                name: check_run.name,
                definitionId: external_ids[0],
                buildId: external_ids[1],
                projectId: external_ids[2],
            };
        }
    }
    return null;
}

async function getProperties(check_run) {
    var info = getAzDevInfoFromCheckPayload(check_run);
    if (!info){
        return null;
    }
    var connection = await getconnection(info.org);
    var build = await connection.getBuildApi();
    var properties = await build.getBuildProperties(info.projectId, info.buildId);
    console.log(`check_run: ${check_run.id}`);
    console.log(`check_run details_url: ${check_run.details_url}`);
    var result = {};
    if (properties != null && 'value' in properties){
        for (const [key, value] of Object.entries(properties.value)) {
            if ('$value' in value){
                result[key] = value['$value'];
            }
        }
    }

    return result;
}

module.exports = Object.freeze({
    getAzDevInfoFromCheckPayload: getAzDevInfoFromCheckPayload,
    getProperties: getProperties,
});