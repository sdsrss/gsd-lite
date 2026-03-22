// State module — re-exports all public API

export { ERROR_CODES, setLockPath } from './constants.js';
export { init, read, update, phaseComplete, addEvidence, pruneEvidence } from './crud.js';
export { selectRunnableTask, propagateInvalidation, buildExecutorContext, reclassifyReviewLevel, matchDecisionForBlocker, applyResearchRefresh, storeResearch } from './logic.js';
