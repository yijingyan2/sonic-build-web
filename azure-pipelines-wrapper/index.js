/**
 * This is the main entrypoint to your Probot app
 * @param {import('probot').Probot} app
 */

const env_init = require('./env_init.js');
const issue_comment = require('./issue_comment');
const check_run = require('./check_run');
const eventhub = require('./eventhub');
const conflict_detect = require('./conflict_detect.js');
const auto_cherrypick = require('./auto_cherrypick.js');
const backport_labels = require('./backport_labels.js');
const qualified_approvals = require('./qualified_approvals.js');

module.exports = async (app) => {
  // Your code here
  app.log.info("Yay, the app was loaded!");
  await env_init.init(app);
  env_init.daemon_run(app);

  issue_comment.init(app);
  check_run.init(app);
  eventhub.init(app);
  conflict_detect.init(app);
  backport_labels.init(app);
  auto_cherrypick.init(app);
  qualified_approvals.init(app);

  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
};
