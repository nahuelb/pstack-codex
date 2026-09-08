import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeRun, appendEvent, attachProof, evaluateRun } from '../scripts/lib/run-record.mjs';
import { compareRuns, renderBenchmark, benchmarkMain } from '../scripts/benchmark-runs.mjs';

async function fixture(t, id, { started = true, finished = true, proof = true, benchmark, served = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-benchmark-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourceRoot = path.join(dir, 'source');
  await mkdir(sourceRoot);
  await writeFile(path.join(sourceRoot, 'source.txt'), 'same case source');
  const runDir = path.join(dir, 'run');
  const manifest = { schemaVersion: 1, runId: id, objective: 'Pass the same assertion', sourceRoot, createdAt: new Date(0).toISOString(), decisions: [{ id: 'd', text: 'Check source' }], criteria: [{ id: 'c', description: 'Source verified', decisionIds: ['d'], checkIds: ['proof'] }], checks: [{ id: 'proof', description: 'Reviewed source', sourcePaths: ['source.txt'] }], units: [{ id: 'u', title: 'Review source', dependsOn: [] }], benchmark: benchmark ?? { caseId: 'same-case', environment: 'same-host-and-input', models: ['test-model'] } };
  await initializeRun(runDir, manifest);
  const actor = { threadId: `${id}-main`, kind: 'main', role: 'review', requestedModel: 'test-model', ...(served ? { servedModel: 'test-model' } : {}) };
  async function record(type, milliseconds, extra = {}) {
    await appendEvent(runDir, { type, at: new Date(milliseconds).toISOString(), actor, ...extra });
  }
  if (started) await record('run_started', 0);
  await record('unit_ready', 10, { unitId: 'u' });
  await record('unit_started', 20, { unitId: 'u' });
  await record('unit_finished', 80, { unitId: 'u', outcome: 'passed' });
  await record('token_usage', 90, { usage: { totalTokens: 75, inputTokens: 50, outputTokens: 25, cachedInputTokens: 40, reasoningOutputTokens: 15 }, source: 'fixture tool receipt' });
  if (finished) await record('run_finished', 100);
  const artifact = path.join(dir, 'proof.md');
  await writeFile(artifact, 'Source matches expected fixture');
  if (proof) await attachProof(runDir, 'proof', { artifact, verdict: 'passed', summary: 'Source verified', actor });
  return { runDir, sourceRoot, artifact, evaluation: await evaluateRun(runDir) };
}

test('real acceptable runs compare observed metrics without fabricated baseline or speedup', async (t) => {
  const a = await fixture(t, 'a');
  const b = await fixture(t, 'b');
  const result = compareRuns([a.evaluation, b.evaluation]);
  assert.equal(result.comparable, true);
  assert.equal(result.runs[0].elapsedMs, 100);
  assert.equal(result.runs[0].queue.sumMs, 10);
  assert.equal(result.runs[0].totalTokens, 75);
  assert.equal(result.runs[0].externalWait.unionMs, null);
  const markdown = renderBenchmark(result);
  assert.match(markdown, /\*\*Comparable\*\*/);
  assert.match(markdown, /null \(missing\)/);
  assert.doesNotMatch(markdown, /\d+(?:\.\d+)?x|\d+%|speedup:/);
  const cli = execFileSync(process.execPath, ['scripts/benchmark-runs.mjs', a.runDir, b.runDir], { encoding: 'utf8' });
  assert.match(cli, /\*\*Comparable\*\*/);
});

test('missing start, missing finish, and unverified served models each forbid comparison', async (t) => {
  const a = await fixture(t, 'a');
  for (const options of [{ started: false }, { finished: false }, { served: false }]) {
    const b = await fixture(t, 'b', options);
    const result = compareRuns([a.evaluation, b.evaluation]);
    assert.equal(result.comparable, false);
    assert.match(result.reasons.join(' '), /evidence|unverified/);
  }
});

test('missing, stale, and failed acceptance proof cannot qualify a finished run', async (t) => {
  const a = await fixture(t, 'a');
  const b = await fixture(t, 'b', { proof: false });
  assert.equal(compareRuns([a.evaluation, b.evaluation]).comparable, false);
  await attachProof(b.runDir, 'proof', { artifact: b.artifact, verdict: 'failed', summary: 'Mismatch' });
  assert.equal(compareRuns([a.evaluation, await evaluateRun(b.runDir)]).comparable, false);
  await attachProof(b.runDir, 'proof', { artifact: b.artifact, verdict: 'passed', summary: 'Fixed' });
  assert.equal(compareRuns([a.evaluation, await evaluateRun(b.runDir)]).comparable, true);
  await writeFile(path.join(b.sourceRoot, 'source.txt'), 'changed');
  assert.equal(compareRuns([a.evaluation, await evaluateRun(b.runDir)]).comparable, false);
});

test('case, environment, declared/served models and acceptance contract must match', async (t) => {
  const a = await fixture(t, 'a');
  const b = await fixture(t, 'b');
  for (const [label, mutate] of [
    ['caseId', (run) => { run.manifest.benchmark.caseId = 'other'; }],
    ['environment', (run) => { run.manifest.benchmark.environment = 'other'; }],
    ['declared model setup', (run) => { run.manifest.benchmark.models = ['other']; }],
    ['observed model setup', (run) => { for (const event of run.events) if (event.actor) event.actor.servedModel = 'other'; }],
    ['acceptance contract', (run) => { run.manifest.criteria[0].description = 'Different obligation'; }],
  ]) {
    const changed = structuredClone(b.evaluation);
    mutate(changed);
    const comparison = compareRuns([a.evaluation, changed]);
    assert.equal(comparison.comparable, false);
    assert.ok(comparison.reasons.some((reason) => reason.includes(label)), comparison.reasons.join(' '));
  }
});

test('canonical comparison ignores collection order, but preserves command argument order', async (t) => {
  const a = await fixture(t, 'a');
  const b = await fixture(t, 'b');
  a.evaluation.manifest.checks[0].command = ['node', '--test', 'test.mjs'];
  b.evaluation.manifest.checks[0].command = ['node', 'test.mjs', '--test'];
  assert.equal(compareRuns([a.evaluation, b.evaluation]).comparable, false);
  b.evaluation.manifest.checks[0].command = ['node', '--test', 'test.mjs'];
  b.evaluation.manifest.checks[0] = Object.fromEntries(Object.entries(b.evaluation.manifest.checks[0]).reverse());
  assert.equal(compareRuns([a.evaluation, b.evaluation]).comparable, true);
});

test('duplicate or ambiguous runs and malformed CLI input fail clearly', async (t) => {
  const a = await fixture(t, 'a');
  const b = await fixture(t, 'b');
  assert.equal(compareRuns([a.evaluation, a.evaluation]).comparable, false);
  await appendEvent(b.runDir, { type: 'run_started', at: new Date(1).toISOString() });
  assert.equal(compareRuns([a.evaluation, await evaluateRun(b.runDir)]).comparable, false);
  await assert.rejects(benchmarkMain([a.runDir, a.runDir]), /distinct/);
  await assert.rejects(benchmarkMain([a.runDir]), /Usage/);
  let output = '';
  await benchmarkMain([a.runDir, b.runDir], { stdout: (text) => { output += text; } });
  assert.match(output, /Noncomparable/);
  assert.equal((await readFile(path.join(a.runDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).length, a.evaluation.events.length);
});

test('missing benchmark metadata and explicit failed finish remain noncomparable', async (t) => {
  const a = await fixture(t, 'a');
  const b = await fixture(t, 'b');
  delete b.evaluation.manifest.benchmark;
  let comparison = compareRuns([a.evaluation, b.evaluation]);
  assert.equal(comparison.comparable, false);
  assert.match(comparison.reasons.join(' '), /setup is missing/);
  b.evaluation = await evaluateRun(b.runDir);
  b.evaluation.events.find((event) => event.type === 'run_finished').outcome = 'failed';
  comparison = compareRuns([a.evaluation, b.evaluation]);
  assert.equal(comparison.comparable, false);
  assert.match(comparison.reasons.join(' '), /non-success outcome/);
});

test('identical parallel actors do not change setup, but roles, models and missing observations do', async (t) => {
  const a = await fixture(t, 'a');
  const b = await fixture(t, 'b');
  async function addActor(run, id, changes = {}) {
    await appendEvent(run.runDir, {
      type: 'token_usage', at: new Date(95).toISOString(), source: 'fixture receipt', usage: { totalTokens: 10 },
      actor: { threadId: id, kind: 'subagent', role: 'review', requestedModel: 'test-model', servedModel: 'test-model', ...changes },
    });
    run.evaluation = await evaluateRun(run.runDir);
  }
  await addActor(a, 'sub-a');
  await addActor(b, 'sub-b1');
  await addActor(b, 'sub-b2');
  assert.equal(compareRuns([a.evaluation, b.evaluation]).comparable, true);
  assert.equal(compareRuns([a.evaluation, b.evaluation]).runs[1].totalTokens, 95);
  for (const changes of [{ role: 'build' }, { requestedModel: 'other' }, { servedModel: 'other' }, { role: null }, { servedModel: null }, { requestedModel: null }]) {
    const changed = structuredClone(b.evaluation);
    Object.assign(changed.events.find((event) => event.actor?.threadId === 'sub-b2').actor, changes);
    assert.equal(compareRuns([a.evaluation, changed]).comparable, false, JSON.stringify(changes));
  }
  const changedKind = structuredClone(a.evaluation);
  changedKind.events.find((event) => event.actor?.threadId === 'sub-a').actor.kind = 'main';
  assert.equal(compareRuns([changedKind, b.evaluation]).comparable, false);
});

test('explicit partial integration scope is visible and cannot compare to full task scope', async (t) => {
  const a = await fixture(t, 'a');
  const b = await fixture(t, 'b');
  const manifestPath = path.join(b.runDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.objective = 'Partial integration segment: integrate previously completed work';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await attachProof(b.runDir, 'proof', { artifact: b.artifact, verdict: 'passed', summary: 'Integration assertions passed' });
  b.evaluation = await evaluateRun(b.runDir);
  const comparison = compareRuns([a.evaluation, b.evaluation]);
  assert.equal(comparison.comparable, false);
  assert.match(comparison.reasons.join(' '), /acceptance contract/);
  const markdown = renderBenchmark(comparison);
  assert.match(markdown, /Declared-scope elapsed ms/);
  assert.match(markdown, /Partial integration segment: integrate previously completed work/);
  assert.match(markdown, /earlier work remains unmeasured/);
  assert.match(markdown, /Start\/finish records alone do not prove full-task coverage/);
});
