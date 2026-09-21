// State module — re-exports all public API

export { ERROR_CODES, setLockPath } from './constants.js';
export { init, read, update, phaseComplete, addEvidence, pruneEvidence, patchPlan, computePlanHashes } from './crud.js';
export { selectRunnableTask, phaseReviewSatisfied, propagateInvalidation, propagateCrossPhaseInvalidation, buildExecutorContext, reclassifyReviewLevel, matchDecisionForBlocker, applyResearchRefresh, storeResearch, PROVENANCE_NOTE } from './logic.js';
