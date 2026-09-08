import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { summarizeRun, renderRunReport, renderTicketUpdate, reportMain } from '../scripts/render-run-report.mjs';

import { initializeRun, appendEvent, attachProof, evaluateRun } from '../scripts/lib/run-record.mjs';

const main = { threadId: 'main', kind: 'main', role: 'coordinate', requestedModel: 'model-a', servedModel: 'model-a' };
const sub = { threadId: 'sub', kind: 'subagent', role: 'build', requestedModel: 'model-b' };
const event = (type, ms, extra = {}) => ({ id: `${type}-${ms}`, type, at: new Date(ms).toISOString(), recordedAt: new Date(ms + 5000).toISOString(), ...extra });
function fixture() {
  return {
    manifest: { schemaVersion: 1, runId: 'example', objective: 'Verify report', sourceRoot: '/tmp/source', createdAt: new Date(0).toISOString(), decisions: [{ id: 'd', text: 'Show evidence' }], units: [{ id: 'main-unit', title: 'Coordinate', dependsOn: [] }, { id: 'sub-unit', title: 'Build', dependsOn: [] }], criteria: [{ id: 'c', description: 'Proof exists', decisionIds: ['d'], checkIds: ['check'] }], checks: [{ id: 'check', description: 'Evidence', sourcePaths: ['src'] }] },
    criteria: [{ id: 'c', description: 'Proof exists', decisionIds: ['d'], checkIds: ['check'], status: 'passed' }], checks: [{ id: 'check', description: 'Evidence', status: 'passed', reason: 'Current proof', receipt: { id: 'proof', artifact: '/tmp/proof', finishedAt: new Date(150).toISOString(), origin: 'reviewed-artifact', summary: 'Reviewed assertions' } }], acceptanceComplete: true,
    events: [event('run_started', 0, { actor: main }), event('unit_ready', 5, { unitId: 'main-unit', actor: main }), event('unit_started', 10, { unitId: 'main-unit', actor: main }), event('unit_ready', 15, { unitId: 'sub-unit', actor: main }), event('unit_started', 20, { unitId: 'sub-unit', actor: sub }), event('unit_finished', 70, { unitId: 'sub-unit', actor: sub, outcome: 'failed' }), event('unit_started', 80, { unitId: 'sub-unit', actor: sub }), event('unit_finished', 100, { unitId: 'sub-unit', actor: sub, outcome: 'passed' }), event('unit_finished', 110, { unitId: 'main-unit', actor: main, outcome: 'passed' }), event('token_usage', 120, { actor: main, usage: { totalTokens: 80 }, source: 'tool' }), event('token_usage', 130, { actor: main, usage: { totalTokens: 100, inputTokens: 70, outputTokens: 30, cachedInputTokens: 50, reasoningOutputTokens: 10 }, source: 'tool' }), event('token_usage', 140, { actor: sub, usage: { totalTokens: 20 }, source: 'tool' }), event('run_finished', 200, { actor: main })],
  };
}
async function diskFixture(t, data = fixture()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-report-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourceRoot = path.join(dir, 'source');
  await mkdir(sourceRoot);
  await writeFile(path.join(sourceRoot, 'src'), 'report source');
  const runDir = path.join(dir, 'run');
  await initializeRun(runDir, { ...data.manifest, sourceRoot });
  for (const record of data.events) await appendEvent(runDir, record);
  const artifact = path.join(dir, 'proof.md');
  await writeFile(artifact, 'Reviewed report assertions');
  await attachProof(runDir, 'check', { artifact, verdict: 'passed', summary: 'Reviewed assertions', actor: main });
  return { dir: runDir, sourceRoot, artifact, evaluate: evaluateRun };
}

test('elapsed overlap, queue ownership, retries, and cumulative token snapshots stay honest', () => {
  const summary = summarizeRun(fixture());
  assert.equal(summary.elapsedMs, 200);
  assert.equal(summary.unitSpans.sumMs, 170);
  assert.equal(summary.unitSpans.unionMs, 100);
  assert.equal(summary.queue.sumMs, 10);
  assert.equal(summary.queue.status, 'partial');
  assert.equal(summary.failedUnits, 1);
  assert.equal(summary.reworkCount, 1);
  assert.equal(summary.reworkElapsedMs, 20);
  assert.equal(summary.totalTokens, 120);
  assert.equal(summary.actors[0].usage.totalTokens, 100);
  assert.equal(summary.actors[0].usage.cachedInputTokens, 50);
  assert.equal(summary.actors[1].usage.inputTokens, null);
  assert.deepEqual(summary.actors[1].failedUnits, ['sub-unit']);
  assert.equal(summary.externalWait.unionMs, null);
  assert.equal(summary.externalWait.status, 'missing');
});

test('latest snapshot uses actual event time, preserves null and never sums snapshots', () => {
  const data = fixture();
  data.events.push(event('token_usage', 125, { actor: main, usage: { totalTokens: 900 }, source: 'late import' }));
  assert.equal(summarizeRun(data).totalTokens, 120);
  data.events.push(event('token_usage', 150, { actor: main, usage: { totalTokens: null }, source: 'tool' }));
  assert.equal(summarizeRun(data).totalTokens, null);
  assert.equal(summarizeRun(data).actors[0].usage.inputTokens, null);
});

test('missing, orphan, and unclosed records remain missing or partial', () => {
  const data = fixture();
  data.events = [event('unit_finished', 70, { unitId: 'sub-unit', actor: sub }), event('external_wait_started', 90, { waitId: 'w' })];
  const result = summarizeRun(data);
  assert.equal(result.elapsedMs, null);
  assert.equal(result.unitSpans.status, 'partial');
  assert.equal(result.unitSpans.sumMs, null);
  assert.equal(result.externalWait.status, 'partial');
  assert.equal(result.reworkCount, null);
  assert.equal(result.totalTokens, null);
  const report = renderRunReport(data);
  assert.match(report, /Main agent: not recorded/);
  assert.match(report, /unverified/);
});

test('waits report union, and conflicting actor or duplicate start records are partial', () => {
  const data = fixture();
  data.events.push(event('external_wait_started', 20, { waitId: 'a' }), event('external_wait_started', 30, { waitId: 'b' }), event('external_wait_finished', 50, { waitId: 'a' }), event('external_wait_finished', 70, { waitId: 'b' }));
  assert.equal(summarizeRun(data).externalWait.unionMs, 50);
  assert.equal(summarizeRun(data).externalWait.sumMs, 70);
  data.events.push(event('unit_started', 21, { unitId: 'sub-unit', actor: main }));
  assert.equal(summarizeRun(data).unitSpans.status, 'partial');
});

test('report shows decision trace, proof failures, and separate milestones without claiming release', () => {
  const data = fixture();
  data.acceptanceComplete = false;
  data.criteria[0].status = 'blocked';
  data.checks[0].status = 'stale';
  data.checks[0].reason = 'Source changed | rebuild\nneeded';
  data.checks.push({ id: 'missing', status: 'missing', reason: 'No receipt' }, { id: 'failed', status: 'failed', reason: 'Assertion failed' });
  data.events.push(event('integration_finished', 180, { summary: 'Merged only' }));
  const report = renderRunReport(data);
  assert.match(report, /Acceptance: \*\*blocked\*\*/);
  assert.match(report, /d: Show evidence.*c: Proof exists.*check: stale/);
  assert.match(report, /Source changed &#124; rebuild needed/);
  assert.match(report, /Main-agent reviewed assertion/);
  assert.match(report, /missing.*No receipt/);
  assert.match(report, /failed.*Assertion failed/);
  assert.match(report, /integration_finished:.*Merged only/);
  assert.match(report, /release_finished: not recorded/);
  assert.match(report, /not active model work/);
  assert.match(renderTicketUpdate(data), /draft; not posted/);
});

test('CLI writes report and ticket drafts only to requested files, and supports stdout', async (t) => {
  const { dir, evaluate } = await diskFixture(t);
  let stdout = '';
  const output = path.join(dir, 'report.md');
  const ticket = path.join(dir, 'ticket.md');
  await reportMain([dir, '--output', output, '--ticket-output', ticket], { evaluate, stdout: (text) => { stdout += text; } });
  assert.equal(stdout, '');
  assert.match(await readFile(output, 'utf8'), /# Run closeout: example/);
  assert.match(await readFile(ticket, 'utf8'), /draft; not posted/);
  await reportMain([dir], { evaluate, stdout: (text) => { stdout += text; } });
  assert.match(stdout, /# Run closeout: example/);
  assert.match(stdout, /draft; not posted/);
  await assert.rejects(reportMain([dir, '--output', output, '--ticket-output', output], { evaluate }), /must differ/);
  await assert.rejects(reportMain([dir, '--unknown'], { evaluate }), /Usage/);
});


test('real library evidence freshness blocks acceptance after source or artifact edits', async (t) => {
  const { dir, sourceRoot, artifact } = await diskFixture(t);
  assert.equal((await evaluateRun(dir)).acceptanceComplete, true);
  await writeFile(path.join(sourceRoot, 'src'), 'changed source');
  assert.match(renderRunReport(await evaluateRun(dir)), /check: stale/);
  await attachProof(dir, 'check', { artifact, verdict: 'failed', summary: 'Assertion failed', actor: main });
  assert.match(renderRunReport(await evaluateRun(dir)), /check: failed/);
  await attachProof(dir, 'check', { artifact, verdict: 'passed', summary: 'Reviewed again', actor: main });
  assert.equal((await evaluateRun(dir)).acceptanceComplete, true);
  await rm(artifact);
  assert.match(renderRunReport(await evaluateRun(dir)), /check: stale/);
});

test('acceptance without actual start evidence labels data collection partial', async (t) => {
  const data = fixture();
  data.events = data.events.filter((event) => event.type !== 'run_started');
  const { dir } = await diskFixture(t, data);
  const evaluated = await evaluateRun(dir);
  assert.equal(evaluated.acceptanceComplete, true);
  assert.match(renderRunReport(evaluated), /Data collection: partial. Actual run_started: missing/);
});

test('criteria without a linked decision remain visible, and untouched units mark partial coverage', () => {
  const data = fixture();
  data.manifest.decisions = [];
  data.criteria[0].decisionIds = [];
  data.manifest.criteria[0].decisionIds = [];
  data.manifest.units.push({ id: 'unobserved', title: 'No receipts', dependsOn: [] });
  const report = renderRunReport(data);
  assert.match(report, /No decision linked.*c: Proof exists/);
  assert.match(report, /Units with missing start\/finish records: unobserved/);
  assert.equal(summarizeRun(data).unitSpans.status, 'partial');
});

test('reports and ticket drafts retain explicit partial integration scope without full-task elapsed claims', async (t) => {
  const data = fixture();
  data.manifest.objective = 'Partial integration segment: combine existing changes';
  const { dir } = await diskFixture(t, data);
  const evaluated = await evaluateRun(dir);
  for (const output of [renderRunReport(evaluated), renderTicketUpdate(evaluated)]) {
    assert.match(output, /Partial integration segment: combine existing changes/);
    assert.match(output, /Declared-scope elapsed/);
    assert.match(output, /earlier work/);
    assert.doesNotMatch(output, /(?:Observed end-to-end|End-to-end): 200/);
  }
});
