import { storeResearch } from '../state/index.js';
import { validateResearcherResult } from '../../schema.js';
import { resumeWorkflow } from './resume.js';

export async function handleResearcherResult({ result, artifacts, decision_index, basePath = process.cwd() } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { error: true, message: 'result must be an object' };
  }

  const validation = validateResearcherResult(result);
  if (!validation.valid) {
    return { error: true, message: `Invalid researcher result: ${validation.errors.join('; ')}` };
  }

  const persisted = await storeResearch({ result, artifacts, decision_index, basePath });
  if (persisted.error) return persisted;

  const resumed = await resumeWorkflow({ basePath });
  if (resumed.error) return resumed;

  return {
    ...resumed,
    stored_files: persisted.stored_files,
    decision_ids: persisted.decision_ids,
    research_warnings: persisted.warnings,
  };
}
