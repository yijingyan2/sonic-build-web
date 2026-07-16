const { ManagedIdentityCredential, DefaultAzureCredential } = require("@azure/identity");
require('dotenv').config();

// Well-known Azure DevOps resource (application) ID. A token issued for this
// scope is accepted by the Azure DevOps REST APIs and git endpoints of any
// organization backed by the same Entra tenant as the managed identity.
const ADO_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";

// Use a dedicated credential for Azure DevOps so Key Vault's DefaultAzureCredential
// (in keyvault.js) is left untouched. When ADO_MI_CLIENT_ID is set (App Service with
// a user-assigned managed identity), request tokens as that specific identity;
// otherwise fall back to DefaultAzureCredential (e.g. local dev via `az login`).
const credential = process.env.ADO_MI_CLIENT_ID
    ? new ManagedIdentityCredential({ clientId: process.env.ADO_MI_CLIENT_ID })
    : new DefaultAzureCredential();

let cachedToken = null;

async function getAdoAadToken() {
    // Reuse the cached token until ~5 minutes before it expires.
    if (cachedToken && cachedToken.expiresOnTimestamp - Date.now() > 5 * 60 * 1000) {
        return cachedToken.token;
    }
    cachedToken = await credential.getToken(ADO_SCOPE);
    return cachedToken.token;
}

module.exports = Object.freeze({
    getAdoAadToken: getAdoAadToken,
});
