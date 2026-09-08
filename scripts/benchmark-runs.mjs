#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cell, table, summarizeRun, loadEvaluatedRun } from './render-run-report.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, key === 'command' ? value[key] : canonical(value[key])]));
  return value;
}
const signature = (value) => JSON.stringify(canonical(value));
const observedSetup = (run) => [...new Set(run.actors.map(({ kind, role, requestedModels, servedModels }) => signature({ kind, role, requestedModels, servedModels })))].sort();

export function compareRuns(evaluations) {
  const runs = evaluations.map((evaluation) => ({ evaluation, ...summarizeRun(evaluation) }));
  const reasons = [];
  if (runs.length < 2) reasons.push('At least two real runs are required.');
  const ids = runs.map((run) => run.runId);
  if (new Set(ids).size !== ids.length) reasons.push('Duplicate runId values are not independent runs.');
  for (const run of runs) {
    const benchmark = run.evaluation.manifest.benchmark;
    if (!run.evaluation.acceptanceComplete) reasons.push(`${run.runId}: acceptance is blocked.`);
    if (run.elapsedMs === null) reasons.push(`${run.runId}: actual run_started/run_finished evidence is missing, incomplete, or ambiguous.`);
    if (!benchmark?.caseId || !benchmark.environment || (typeof benchmark.environment === 'object' && !Object.keys(benchmark.environment).length) || !Array.isArray(benchmark.models) || !benchmark.models.length || benchmark.models.some((model) => typeof model !== 'string' || !model.trim())) reasons.push(`${run.runId}: benchmark case, environment, or model setup is missing.`);
    if (!run.actors.length || !run.actors.some((actor) => actor.kind === 'main') || run.actors.some((actor) => !actor.kind || !actor.role || !actor.requestedModels.length || !actor.servedModels.length) || run.evaluation.events.some((event) => /^unit_(started|finished)$/.test(event.type) && !event.actor?.threadId)) reasons.push(`${run.runId}: observed actor/model setup is unverified.`);
    if (run.milestones.run_finished.some((event) => event.outcome && !['passed', 'completed', 'success'].includes(event.outcome))) reasons.push(`${run.runId}: run_finished declares a non-success outcome.`);
  }
  const fields = [
    ['caseId', (run) => run.evaluation.manifest.benchmark?.caseId],
    ['environment', (run) => run.evaluation.manifest.benchmark?.environment],
    ['declared model setup', (run) => run.evaluation.manifest.benchmark?.models],
    ['observed model setup', observedSetup],
    ['acceptance contract', (run) => { const { objective, decisions, criteria, checks } = run.evaluation.manifest; return { objective, decisions, criteria, checks }; }],
  ];
  for (const [label, value] of fields) if (new Set(runs.map((run) => signature(value(run)))).size > 1) reasons.push(`Runs have different ${label}.`);
  return { comparable: reasons.length === 0, reasons, runs };
}

export function renderBenchmark(comparison) {
  const { comparable, reasons, runs } = comparison;
  const value = (number, status) => `${number ?? 'null'}${status ? ` (${status})` : ''}`;
  const lines = ['# Observed run benchmark', '', `**${comparable ? 'Comparable' : 'Noncomparable'}**`, ''];
  for (const reason of reasons) lines.push(`- ${cell(reason)}`);
  lines.push(
    '', 'Observed values below are descriptive. Missing data remain null; no baseline or speedup is inferred.', '',
    table([
      'Run', 'Acceptance / run timing', 'Declared-scope elapsed ms', 'Queue sum ms', 'Unit sum / union ms',
      'Failed / completed receipts', 'Rework starts / elapsed ms', 'External wait union ms', 'Tokens',
    ], runs.map((run) => [
      run.runId,
      `${run.evaluation.acceptanceComplete ? 'passed' : 'blocked'} / ${run.runStatus}; collection ${run.collectionStatus}`,
      value(run.elapsedMs), value(run.queue.sumMs, run.queue.status),
      `${value(run.unitSpans.sumMs)} / ${value(run.unitSpans.unionMs, run.unitSpans.status)}`,
      `${value(run.failedUnits)} / ${value(run.completedUnits)}${run.unknownOutcomeUnits ? `; ${run.unknownOutcomeUnits} unknown outcomes` : ''}`,
      `${value(run.reworkCount)} / ${value(run.reworkElapsedMs, run.reworkStatus)}`,
      value(run.externalWait.unionMs, run.externalWait.status), value(run.totalTokens),
    ])), '',
    'Unit intervals include main and subagent elapsed spans, which can overlap. They do not measure active model work. Queue and wait receipts can be partial. Rework means repeat starts for the same unit; unrecorded rework is unknown. Token values use the latest cumulative actor snapshots; cached input and reasoning output are subsets.',
    '',
    'Observed model setup compares unique kind/role/requested/served combinations. The number of identical actors does not change comparability. Missing role or model observations remain unverified.',
    '',
    'Full end-to-end collection requires an objective covering the full task and an actual run_started at its beginning. A late start for an explicitly partial integration segment measures only that declared scope; earlier work remains unmeasured. Start/finish records alone do not prove full-task coverage. Different objectives are noncomparable.',
    '', '## Comparison setup', '',
  );
  for (const run of runs) {
    lines.push(`- ${cell(run.runId)}: objective ${cell(run.evaluation.manifest.objective)}; case ${cell(run.evaluation.manifest.benchmark?.caseId)}; environment ${cell(JSON.stringify(run.evaluation.manifest.benchmark?.environment) ?? null)}; declared models ${cell(run.evaluation.manifest.benchmark?.models?.join(', ') ?? null)}.`);
    for (const actor of run.actors) lines.push(`  - ${cell(actor.kind)} / ${cell(actor.role)}: requested ${cell(actor.requestedModels.join(', ') || 'unverified')}; served ${cell(actor.servedModels.join(', ') || 'unverified')}.`);
  }
  return `${lines.join('\n')}\n`;
}

export async function benchmarkMain(args, { evaluate = loadEvaluatedRun, stdout = (text) => process.stdout.write(text) } = {}) {
  const usage = 'Usage: node scripts/benchmark-runs.mjs <run-dir> <run-dir>...';
  if (args.length === 1 && args[0] === '--help') { stdout(`${usage}\nCompares unique observed actor/model/role setups, independent of identical actor counts.\nElapsed spans cover each declared objective. Label late collection in the objective as a partial integration segment; it does not measure full task end-to-end time.\n`); return; }
  if (args.length < 2 || args.some((arg) => arg.startsWith('--'))) throw new Error(usage);
  const directories = args.map((arg) => path.resolve(arg));
  if (new Set(directories).size !== directories.length) throw new Error('Provide distinct run directories.');
  const comparison = compareRuns(await Promise.all(directories.map((directory) => evaluate(directory))));
  stdout(renderBenchmark(comparison));
  return comparison;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  benchmarkMain(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
