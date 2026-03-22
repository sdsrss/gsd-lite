#!/usr/bin/env node
// Shared utilities for GSD hooks.
// findGsdDir: walk up from startDir looking for .gsd/state.json
// readState: parse .gsd/state.json, return null on failure
// getProgress: compute progress summary from state

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const _findCache = new Map();

/**
 * Walk from startDir up to filesystem root looking for a .gsd directory
 * that contains state.json. Returns the absolute path to .gsd or null.
 * Results are cached per startDir (positive hits only — null is not cached
 * so that a later-created .gsd directory can be discovered).
 */
function findGsdDir(startDir) {
  if (_findCache.has(startDir)) return _findCache.get(startDir);

  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, '.gsd');
    try {
      if (fs.statSync(candidate).isDirectory()) {
        // Only return if state.json exists (not just an empty .gsd dir)
        if (fs.existsSync(path.join(candidate, 'state.json'))) {
          _findCache.set(startDir, candidate);
          return candidate;
        }
      }
    } catch { /* skip */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // Don't cache negative results
    dir = parent;
  }
}

/**
 * Clear the findGsdDir result cache. Useful for testing.
 */
function clearFindGsdDirCache() {
  _findCache.clear();
}

/**
 * Read and parse .gsd/state.json. Returns parsed object or null on any failure.
 */
function readState(gsdDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(gsdDir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Compute progress summary from state object.
 * Returns { project, workflowMode, currentPhase, totalPhases, currentTask,
 *           phaseName, taskName, acceptedTasks, totalTasks, gitHead }
 */
function getProgress(state) {
  if (!state) return null;

  const phases = state.phases || [];
  let acceptedTasks = 0;
  let totalTasks = 0;
  let phaseName = '';
  let taskName = '';

  for (const phase of phases) {
    const todos = phase.todo || [];
    totalTasks += todos.length;
    acceptedTasks += todos.filter(t => t.lifecycle === 'accepted').length;
    if (phase.id === state.current_phase) {
      phaseName = phase.name || `Phase ${phase.id}`;
      const task = todos.find(t => t.id === state.current_task);
      if (task) {
        taskName = task.name || '';
      }
    }
  }

  return {
    project: state.project || 'Unknown',
    workflowMode: state.workflow_mode || 'unknown',
    currentPhase: state.current_phase,
    totalPhases: state.total_phases || phases.length,
    currentTask: state.current_task,
    phaseName,
    taskName,
    acceptedTasks,
    totalTasks,
    gitHead: state.git_head || '',
  };
}

module.exports = { findGsdDir, clearFindGsdDirCache, readState, getProgress };
