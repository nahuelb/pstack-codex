#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tokenFields = ['totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens'];
const time = (event) => Date.parse(event?.at);
const knownNumber = (value) => Number.isFinite(value) && value >= 0 ? value : null;
export const cell = (value) => String(value ?? 'null').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('\r', ' ').replaceAll('\n', ' ');
export const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map((row) => `| ${row.map(cell).join(' | ')} |`).join('\n');

export function intervalUnion(spans) {
  const sorted = spans.map(({ start, end }) => [start, end]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let right = -Infinity;
  for (const [start, end] of sorted) {
    total += Math.max(0, end - Math.max(start, right));
    right = Math.max(right, end);
  }
  return total;
}

function pairedSpans(events, startType, finishType, key) {
  const open = new Map();
  const spans = [];
  let unmatched = 0;
  let seen = 0;
  for (const event of events) {
    if (event.type !== startType && event.type !== finishType) continue;
    seen++;
    const id = event[key];
    if (!id || !Number.isFinite(time(event))) { unmatched++; continue; }
    if (event.type === startType) {
      if (open.has(id)) unmatched++;
      open.set(id, event);
    } else {
      const start = open.get(id);
      open.delete(id);
      if (!start || time(event) < time(start) || (startType === 'unit_started' && start.actor?.threadId && event.actor?.threadId && start.actor.threadId !== event.actor.threadId)) {
        unmatched++;
        continue;
      }
      spans.push({ id, start: time(start), end: time(event), actorId: start.actor?.threadId ?? event.actor?.threadId ?? null, outcome: event.outcome });
    }
  }
  unmatched += open.size;
  return { spans, unmatched, status: !seen ? 'missing' : unmatched ? 'partial' : 'observed', sumMs: spans.length ? spans.reduce((sum, span) => sum + span.end - span.start, 0) : null, unionMs: spans.length ? intervalUnion(spans) : null };
}

export function summarizeRun(evaluation) {
  const { manifest, events } = evaluation;
  const ordered = events.map((event, index) => ({ ...event, index })).sort((a, b) => time(a) - time(b) || a.index - b.index);
  const starts = ordered.filter((e) => e.type === 'run_started');
  const finishes = ordered.filter((e) => e.type === 'run_finished');
  const elapsedMs = starts.length === 1 && finishes.length === 1 && time(finishes[0]) >= time(starts[0]) ? time(finishes[0]) - time(starts[0]) : null;
  const runStatus = elapsedMs !== null ? 'observed' : !starts.length && !finishes.length ? 'missing' : 'incomplete or ambiguous';
  const unitSpans = pairedSpans(ordered, 'unit_started', 'unit_finished', 'unitId');
  const missingUnitRecords = manifest.units.filter((unit) => !ordered.some((event) => event.type === 'unit_started' && event.unitId === unit.id) || !ordered.some((event) => event.type === 'unit_finished' && event.unitId === unit.id)).map((unit) => unit.id);
  if (missingUnitRecords.length && unitSpans.status === 'observed') unitSpans.status = 'partial';
  const queue = pairedSpans(ordered, 'unit_ready', 'unit_started', 'unitId');
  const externalWait = pairedSpans(ordered, 'external_wait_started', 'external_wait_finished', 'waitId');
  const actors = new Map();
  for (const event of ordered) {
    const actor = event.actor ?? event.receipt?.actor;
    if (!actor?.threadId) continue;
    if (!actors.has(actor.threadId)) actors.set(actor.threadId, { threadId: actor.threadId, kind: null, role: null, requestedModels: new Set(), servedModels: new Set(), usage: null, usageSource: null });
    const row = actors.get(actor.threadId);
    row.kind = actor.kind ?? row.kind;
    row.role = actor.role ?? row.role;
    if (actor.requestedModel) row.requestedModels.add(actor.requestedModel);
    if (actor.servedModel) row.servedModels.add(actor.servedModel);
    if (event.type === 'token_usage') {
      row.usage = Object.fromEntries(tokenFields.map((field) => [field, knownNumber(event.usage?.[field])]));
      row.usageSource = event.source ?? null;
    }
  }
  const actorRows = [...actors.values()].map((actor) => {
    const spans = unitSpans.spans.filter((span) => span.actorId === actor.threadId);
    const actorEvents = ordered.filter((e) => e.actor?.threadId === actor.threadId);
    const endings = actorEvents.filter((e) => e.type === 'unit_finished');
    return {
      ...actor, requestedModels: [...actor.requestedModels].sort(), servedModels: [...actor.servedModels].sort(), spans,
      elapsedSumMs: spans.length ? spans.reduce((sum, span) => sum + span.end - span.start, 0) : null,
      elapsedUnionMs: spans.length ? intervalUnion(spans) : null,
      elapsedStatus: pairedSpans(actorEvents, 'unit_started', 'unit_finished', 'unitId').status,
      completedUnits: endings.length ? endings.filter((e) => e.outcome === 'passed').map((e) => e.unitId) : null,
      failedUnits: endings.length ? endings.filter((e) => e.outcome === 'failed').map((e) => e.unitId) : null,
      usage: actor.usage ?? Object.fromEntries(tokenFields.map((field) => [field, null])),
    };
  });
  const endings = ordered.filter((e) => e.type === 'unit_finished');
  const unitStarts = ordered.filter((e) => e.type === 'unit_started');
  const failed = endings.filter((e) => e.outcome === 'failed').length;
  const startCounts = new Map();
  let reworkElapsedMs = null;
  let reworkSpans = 0;
  for (const event of unitStarts) {
    const previous = startCounts.get(event.unitId) ?? 0;
    startCounts.set(event.unitId, previous + 1);
    if (!previous) continue;
    const span = unitSpans.spans.find((item) => item.id === event.unitId && item.start === time(event));
    if (span) { reworkElapsedMs = (reworkElapsedMs ?? 0) + span.end - span.start; reworkSpans++; }
  }
  const reworkCount = unitStarts.length ? [...startCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0) : null;
  const tokenCoverage = actorRows.length && actorRows.some((actor) => actor.kind === 'main') && !ordered.some((e) => /^unit_(started|finished)$/.test(e.type) && !e.actor?.threadId);
  const totalTokens = tokenCoverage && actorRows.every((actor) => actor.usage.totalTokens !== null) ? actorRows.reduce((sum, actor) => sum + actor.usage.totalTokens, 0) : null;
  return {
    runId: manifest.runId, elapsedMs, runStatus,
    collectionStatus: elapsedMs === null ? 'partial' : 'observed boundaries',
    missingUnitRecords, unitSpans, queue, externalWait, actors: actorRows, totalTokens,
    failedUnits: endings.length ? failed : null,
    completedUnits: endings.length ? endings.filter((e) => e.outcome === 'passed').length : null,
    unknownOutcomeUnits: endings.filter((e) => !['passed', 'failed'].includes(e.outcome)).length,
    reworkCount, reworkElapsedMs,
    reworkStatus: reworkCount === null ? 'missing' : reworkCount > reworkSpans ? 'partial' : 'observed',
    milestones: Object.fromEntries(['run_finished', 'integration_finished', 'release_finished'].map((type) => [type, events.filter((e) => e.type === type)])),
  };
}

const metric = (value, status = 'observed') => `${value ?? 'null'} ms (${status})`;
const unitList = (units) => units === null ? 'null' : units.length ? units.join(', ') : '0 observed';

export function renderRunReport(evaluation) {
  const { manifest, criteria, checks, acceptanceComplete } = evaluation;
  const summary = summarizeRun(evaluation);
  const trace = criteria.flatMap((criterion) => (criterion.decisionIds.length ? criterion.decisionIds : [null]).map((id) => {
    const decision = manifest.decisions.find((item) => item.id === id);
    return [decision ? `${decision.id}: ${decision.text}` : 'No decision linked', `${criterion.id}: ${criterion.description}`, criterion.status, criterion.checkIds.map((checkId) => `${checkId}: ${checks.find((check) => check.id === checkId)?.status ?? 'missing'}`).join('; ')];
  }));
  const lines = [`# Run closeout: ${cell(manifest.runId)}`, '', cell(manifest.objective), '', `Acceptance: **${acceptanceComplete ? 'passed' : 'blocked'}**. Acceptance does not establish task completion, integration, or release.`, '', '## Declared milestones', ''];
  for (const [type, events] of Object.entries(summary.milestones)) {
    lines.push(`- ${type}: ${events.length ? events.map((e) => `${cell(e.at)} (event ${cell(e.id)}${e.outcome ? `; outcome ${cell(e.outcome)}` : ''}${e.summary ? `; ${cell(e.summary)}` : ''})`).join('; ') : 'not recorded'}.`);
  }
  lines.push(
    '', '## Decisions → criteria → checks', '',
    table(['Decision', 'Criterion', 'Acceptance', 'Checks'], trace),
    '', '## Evidence', '',
    table(['Check', 'Status', 'Reason', 'Proof'], checks.map((check) => [
      `${check.id}: ${check.description}`, check.status, check.reason,
      check.receipt
        ? `${check.receipt.origin === 'reviewed-artifact' ? 'Main-agent reviewed assertion' : 'Command receipt'} ${check.receipt.id}; ${check.receipt.artifact}; ${check.receipt.finishedAt}; ${check.receipt.summary ?? ''}`
        : 'missing',
    ])),
    '', '## Observed timing and work', '',
    `Data collection: ${summary.collectionStatus}. Actual run_started: ${evaluation.events.some((event) => event.type === 'run_started') ? 'recorded' : 'missing'}.`,
    `Declared-scope elapsed (run_started → run_finished): ${metric(summary.elapsedMs, summary.runStatus)}.`,
    `Unit elapsed spans: sum ${metric(summary.unitSpans.sumMs, summary.unitSpans.status)}; union ${metric(summary.unitSpans.unionMs, summary.unitSpans.status)}.`,
    `Queue delay (ready → started): ${metric(summary.queue.sumMs, summary.queue.status)}. External wait union: ${metric(summary.externalWait.unionMs, summary.externalWait.status)}.`,
    `Units with missing start/finish records: ${summary.missingUnitRecords.length ? summary.missingUnitRecords.map(cell).join(', ') : 'none observed'}.`,
    `Completed unit receipts: ${summary.completedUnits ?? 'null'}; failed: ${summary.failedUnits ?? 'null'}; unknown outcome: ${summary.unknownOutcomeUnits}.`,
    `Rework (repeat unit starts): ${summary.reworkCount ?? 'null'}; elapsed sum: ${metric(summary.reworkElapsedMs, summary.reworkStatus)}.`,
    '',
    'Full end-to-end collection requires an objective covering the full task and an actual run_started at its beginning. An explicitly partial integration segment measures only its declared scope; earlier work remains unmeasured. Start/finish records alone do not prove full-task coverage.',
    '',
    'Times are observed elapsed spans, not active model work. Main and subagent intervals can overlap. Missing or partial records do not establish zero time or zero work.',
    '', '## Actors', '',
    table([
      'Actor / role', 'Requested model', 'Served model', 'Elapsed sum / union (ms)',
      'Completed / failed units', 'Tokens total / input / output / cached input / reasoning output',
    ], summary.actors.map((actor) => [
      `${actor.kind ?? 'unverified'} ${actor.threadId} / ${actor.role ?? 'unverified'}`,
      actor.requestedModels.join(', ') || 'unverified', actor.servedModels.join(', ') || 'unverified',
      `${actor.elapsedSumMs ?? 'null'} / ${actor.elapsedUnionMs ?? 'null'} (${actor.elapsedStatus})`,
      `${unitList(actor.completedUnits)} / ${unitList(actor.failedUnits)}`,
      tokenFields.map((field) => actor.usage[field] ?? 'null').join(' / '),
    ])),
  );
  if (!summary.actors.some((actor) => actor.kind === 'main')) lines.push('', 'Main agent: not recorded; role, models, elapsed spans, units, and tokens are unverified/null.');
  lines.push('', `Total tokens across observed actors: ${summary.totalTokens ?? 'null'}. Latest cumulative snapshot per actor; cached and reasoning counts are subsets, never added. Actor coverage is limited to receipts.`);
  for (const actor of summary.actors) {
    lines.push(`- ${cell(actor.threadId)} token source: ${cell(actor.usageSource)}. Unit spans: ${actor.spans.length ? actor.spans.map((span) => `${cell(span.id)} ${new Date(span.start).toISOString()} → ${new Date(span.end).toISOString()}`).join('; ') : 'missing'}.`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderTicketUpdate(evaluation) {
  const summary = summarizeRun(evaluation);
  const lines = ['# Proposed ticket update (draft; not posted)', '', `Run: ${cell(evaluation.manifest.runId)}. ${cell(evaluation.manifest.objective)}`, '', `Acceptance: **${evaluation.acceptanceComplete ? 'passed' : 'blocked'}**. Data collection: ${summary.collectionStatus}.`, '', 'Criteria and current proof:'];
  for (const criterion of evaluation.criteria) {
    lines.push(`- ${cell(criterion.id)}: ${cell(criterion.description)} — ${criterion.status}; decisions: ${cell(criterion.decisionIds.join(', ') || 'none linked')}.`);
    for (const id of criterion.checkIds) {
      const check = evaluation.checks.find((item) => item.id === id);
      lines.push(`  - ${cell(id)}: ${check?.status ?? 'missing'}; ${cell(check?.reason ?? 'No receipt')}${check?.receipt ? `; artifact ${cell(check.receipt.artifact)} (${cell(check.receipt.origin)}; receipt ${cell(check.receipt.id)})` : ''}.`);
    }
  }
  lines.push('', 'Declared milestones (separate from acceptance):');
  for (const [type, events] of Object.entries(summary.milestones)) lines.push(`- ${type}: ${events.length ? events.map((event) => `${cell(event.at)} (event ${cell(event.id)}${event.outcome ? `; outcome ${cell(event.outcome)}` : ''}${event.summary ? `; ${cell(event.summary)}` : ''})`).join('; ') : 'not recorded'}.`);
  lines.push('', `Declared-scope elapsed: ${metric(summary.elapsedMs, summary.runStatus)}; tokens: ${summary.totalTokens ?? 'null'}. Acceptance alone does not establish task completion, integration, or release.`);
  lines.push('', 'Full end-to-end collection requires the full-task objective and an actual start at its beginning. A partial integration segment excludes earlier work.');
  return `${lines.join('\n')}\n`;
}

export async function loadEvaluatedRun(runDir) {
  const { evaluateRun } = await import('./lib/run-record.mjs');
  return evaluateRun(runDir);
}

export async function reportMain(args, { evaluate = loadEvaluatedRun, stdout = (text) => process.stdout.write(text) } = {}) {
  const usage = 'Usage: node scripts/render-run-report.mjs <run-dir> [--output path] [--ticket-output path]';
  if (args.length === 1 && args[0] === '--help') { stdout(`${usage}\nElapsed spans cover the declared objective. Label late collection in the objective as a partial integration segment; it does not measure full task end-to-end time.\n`); return; }
  const [runDir, ...options] = args;
  if (!runDir || runDir.startsWith('--')) throw new Error(usage);
  const outputs = {};
  for (let i = 0; i < options.length; i += 2) {
    if (!['--output', '--ticket-output'].includes(options[i]) || !options[i + 1] || options[i + 1].startsWith('--') || outputs[options[i]]) throw new Error(usage);
    outputs[options[i]] = path.resolve(options[i + 1]);
  }
  if (outputs['--output'] && outputs['--output'] === outputs['--ticket-output']) throw new Error('Report and ticket output paths must differ.');
  const evaluation = await evaluate(path.resolve(runDir));
  const report = renderRunReport(evaluation);
  const ticket = renderTicketUpdate(evaluation);
  if (outputs['--output']) await writeFile(outputs['--output'], report); else stdout(report);
  if (outputs['--ticket-output']) await writeFile(outputs['--ticket-output'], ticket);
  else stdout(`\n${ticket}`);
  return { report, ticket };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  reportMain(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
