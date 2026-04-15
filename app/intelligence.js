// This file has been split into:
//   intelligence/reasoning.js  — reason() pre-call
//   intelligence/annotation.js — annotateSession()
// This stub exists only to prevent require() errors from unmigrated code.
const { reason } = require('./intelligence/reasoning');
const { annotateSession } = require('./intelligence/annotation');
module.exports = { reason, annotateSession };
