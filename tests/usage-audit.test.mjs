import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { auditUsage, hashThreadId, renderUsageMarkdown, projectLog } from '../scripts/lib/usage-audit.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/usage-audit/${name}.json`, import.meta.url)));
const run = (extra = {}) => auditUsage({ rootId: 'main', cutoff: '2026-09-09T13:00:00Z',
  snapshots: [fixture('history')], logs: [fixture('logs')], roleBindings: fixture('roles'), ...extra });
const log = () => fixture('logs').logs[1];
const total = report => report.totals.totalTokens.reported.value;

test('separates main agent, siblings, nested agents, roles and model attempts with evidence', () => {
  const report = run();
  assert.equal(total(report), 2400);
  assert.equal(report.totals.totalTokens.estimated.value, 600);
  assert.equal(report.coverage.duplicateRequests, 1);
  assert.equal(report.coverage.records, 9);
  assert.equal(report.coverage.missingRecords, 1);
  assert.equal(report.coverage.attributedRecords, 8);
  assert.equal(report.coverage.roleAttributedRecords, 7);
  assert.equal(report.rankings.byAgent.find(r => r.threadId === 'main').metrics.totalTokens.reported.value, 120);
  assert.equal(report.rankings.byAgent.find(r => r.threadId === 'builder').metrics.totalTokens.reported.value, 340);
  assert.equal(report.rankings.byAgent.find(r => r.threadId === null).metrics.totalTokens.reported.value, 1100);
  assert.equal(report.rankings.byAgent.find(r => r.threadId === null).rank, null);
  assert.equal(report.rankings.byAgent.find(r => r.threadId === 'tester').rank, 1);
  assert.equal(report.rankings.byParentTask.find(r => r.parentTask === 'builder').metrics.totalTokens.reported.value, 480);
  assert.equal(report.rankings.byRole.find(r => r.role === 'test-runner').metrics.totalTokens.reported.value, 480);
  assert.equal(report.coverage.expectedAgents, 3);
  assert.equal(report.coverage.internalRecoveryRecords, 1);
  assert.ok(report.rows.find(r => r.threadId === 'tester').roleEvidence[0].source.includes('dispatch-test'));
  for (const ranking of Object.values(report.rankings)) {
    assert.equal(ranking.reduce((sum, r) => sum + (r.metrics.totalTokens.reported.value ?? 0), 0), 2400);
  }
});

test('filters at attempt level so final request model does not hide retries', () => {
  const report = run({ model: 'claude-fable-5-1', provider: 'anthropic' });
  assert.equal(total(report), 1880);
  assert.equal(report.coverage.missingRecords, 1);
  assert.ok(report.rows.some(r => r.id === 'r-retry:1'));
  assert.ok(!report.rows.some(r => r.id === 'r-retry:2'));
  assert.equal(report.costs.requestEstimates.find(r => r.requestId === 'r-retry').estimatedApiCostUsd, null);
  assert.equal(run({ model: 'anthropic/claude-fable-5-1' }).coverage.records, 0);
});

test('cache aliases and reasoning remain details; missing fields differ from explicit zero', () => {
  const row = log();
  row.usage = undefined;
  delete row.attempts[0].usage.cacheCreationInputTokens;
  row.attempts[0].usage.reasoningOutputTokens = 0;
  const report = run({ logs: [[row]] });
  assert.equal(total(report), 240);
  assert.equal(report.totals.cachedInputTokens.reported.value, 100);
  assert.equal(report.totals.cacheReadInputTokens.reported.value, 100);
  assert.equal(report.totals.cacheCreationInputTokens.reported.value, null);
  assert.equal(report.totals.cacheCreationInputTokens.missingRecords, 1);
  assert.equal(report.totals.reasoningOutputTokens.reported.value, 0);
  delete row.attempts[0].usage.totalTokens;
  assert.equal(run({ logs: [[row]] }).rows[0].totalBasis, 'input + output');
  row.attempts[0].usage.totalTokens = 400;
  assert.equal(total(run({ logs: [[row]] })), 400);
});

test('historical grouping never identifies the main agent or guesses a role', () => {
  const rows = fixture('logs').logs;
  for (const row of rows) delete row.attribution;
  const report = run({ logs: [rows] });
  assert.equal(total(report), 2400);
  assert.equal(report.coverage.attributedRecords, 0);
  assert.equal(report.coverage.roleAttributedRecords, 0);
  assert.equal(report.rankings.byAgent.length, 1);
  assert.equal(report.rankings.byAgent[0].threadId, null);
  assert.equal(report.rankings.byRole[0].role, null);
});

test('self-grouped requests do not turn their conversation group into an inferred delegating task', () => {
  const row = log();
  row.conversationId = hashThreadId('builder');
  assert.equal(run({ logs: [[row]] }).rows[0].parentTask, 'main');
  delete row.attribution;
  const report = run({ logs: [[row]] });
  assert.equal(total(report), 240);
  assert.equal(report.rows[0].conversationGroup, 'builder');
  assert.equal(report.rows[0].parentTask, null);
  assert.equal(report.rankings.byParentTask[0].parentTask, null);
  assert.equal(report.rankings.byParentTask[0].rank, null);
  assert.equal(report.rankings.byConversationGroup[0].conversationGroup, 'builder');
  assert.equal(report.rankings.byConversationGroup[0].metrics.totalTokens.reported.value, 240);
});

test('null optional counters preserve valid usage and remain unavailable details', () => {
  const row = log();
  row.attempts[0].usage.reasoningOutputTokens = null;
  row.attempts[0].usage.cacheCreationInputTokens = null;
  row.attempts[0].totalTokens = null;
  const report = run({ logs: [[row]] });
  assert.equal(total(report), 240);
  assert.equal(report.totals.inputTokens.reported.value, 200);
  assert.equal(report.totals.outputTokens.reported.value, 40);
  assert.equal(report.totals.reasoningOutputTokens.reported.value, null);
  assert.equal(report.totals.reasoningOutputTokens.missingRecords, 1);
  assert.equal(report.quarantine.length, 0);
  row.attempts[0].usage.totalTokens = null;
  assert.equal(total(run({ logs: [[row]] })), 240);
});

test('resumed agent stays one actor; distinct requests count and repeated exports do not', () => {
  const report = run({ logs: [fixture('logs'), fixture('logs')] });
  assert.equal(total(report), 2400);
  assert.equal(report.rankings.byAgent.filter(r => r.threadId === 'builder').length, 1);
  assert.equal(report.coverage.duplicateRequests, 10);
});

test('quarantines conflicting snapshots independent of order, and duplicate attempt ordinals', () => {
  const a = log(), b = log();
  b.attempts[0].usage.inputTokens++;
  for (const rows of [[a, b], [b, a]]) {
    const report = run({ logs: [rows] });
    assert.equal(total(report), null);
    assert.ok(report.quarantine.some(q => q.reason === 'conflicting-request-snapshots'));
  }
  a.attempts.push(structuredClone(a.attempts[0]));
  assert.ok(run({ logs: [[a]] }).quarantine.some(q => q.reason === 'invalid-attempt-ordinals'));
});

test('rejects cumulative and subtree counters without differencing or adding snapshots', () => {
  for (const field of ['cumulative', 'includesAgents']) {
    const a = log(); a[field] = true;
    assert.equal(total(run({ logs: [[a]] })), null);
    delete a[field]; a.attempts[0][field] = true;
    assert.equal(total(run({ logs: [[a]] })), null);
  }
  const row = log(); row.scope = 'thread';
  assert.equal(total(run({ logs: [[row]] })), null);
  row.scope = 'request'; row.attempts[0].usage = { contextTotalTokens: 9999 };
  const report = run({ logs: [[row]] });
  assert.equal(total(report), null);
  assert.equal(report.coverage.missingRecords, 1);
});

test('unmatched threads, forged ancestry, and unbound role names cannot enter rankings', () => {
  const a = log(); a.attribution.threadId = hashThreadId('foreign');
  assert.equal(total(run({ logs: [[a]] })), null);
  const b = log(); b.attribution.parentThreadId = hashThreadId('reviewer');
  assert.equal(total(run({ logs: [[b]] })), null);
  const c = log(); c.conversationId = hashThreadId('foreign');
  assert.equal(total(run({ logs: [[c]] })), null);
  const roles = fixture('roles'); roles[0].dispatchItemId = 'invented';
  assert.equal(run({ roleBindings: roles }).rows.find(r => r.threadId === 'builder').role, null);
  assert.equal(run({ snapshots: [], logs: [[log()]] }).coverage.records, 0);
});

test('role changes use explicit windows; overlapping conflicting assignments remain unattributed', () => {
  const roles = fixture('roles');
  roles[0].to = '2026-09-09T12:05:00Z';
  roles.push({ ...roles[0], role: 'debugger', from: roles[0].to, to: '2026-09-09T13:00:00Z' });
  const report = run({ roleBindings: roles });
  assert.equal(report.rows.find(r => r.requestId === 'r-build').role, 'implementer');
  assert.equal(report.rows.find(r => r.requestId === 'r-resumed').role, 'debugger');
  roles[0].to = '2026-09-09T13:00:00Z';
  const conflict = run({ roleBindings: roles });
  assert.equal(conflict.rows.find(r => r.requestId === 'r-resumed').role, null);
  assert.ok(conflict.quarantine.some(q => q.reason === 'conflicting-role-assignments'));
});

test('observed request window is exclusive at cutoff and refuses usage before spawn', () => {
  const report = run({ since: '2026-09-09T12:03:00Z', cutoff: '2026-09-09T12:04:00Z' });
  assert.equal(total(report), 240);
  assert.equal(report.rows.length, 1);
  const a = log(); a.timestamp = Date.parse('2026-09-09T11:59:00Z');
  assert.equal(total(run({ logs: [[a]] })), null);
  assert.throws(() => run({ cutoff: '2026-09-09' }), /time window/);
});

test('missing, unsupported and malformed usage never becomes zero or reported usage', () => {
  for (const status of ['unreported', 'unsupported', undefined]) {
    const row = log(); row.attempts[0].usageStatus = status;
    const report = run({ logs: [[row]] });
    assert.equal(total(report), null);
    assert.equal(report.coverage.missingRecords, 1);
  }
  for (const value of [-1, 0.5, '10', Number.MAX_SAFE_INTEGER + 1]) {
    const row = log(); row.attempts[0].usage.inputTokens = value;
    assert.equal(total(run({ logs: [[row]] })), null);
  }
  const row = log(); row.attempts[0].usage.totalTokens = 1;
  assert.equal(total(run({ logs: [[row]] })), null);
});

test('uses old aggregate-only requests once and keeps costs separate from token grades and billing', () => {
  const row = log(); delete row.attempts;
  const report = run({ logs: [[row]] });
  assert.equal(total(report), 240);
  assert.equal(report.coverage.aggregateOnlyRecords, 1);
  assert.equal(report.costs.actualBilling, null);
  assert.equal(report.costs.subscriptionQuota, null);
  assert.equal(report.costs.attemptEstimateUsd, 0.01);
  assert.equal(report.costs.requestEstimateUsd, 0.01);
  assert.match(report.costs.rule, /Never add/);
});

test('only accounting fields enter reports; account-wide summaries are rejected', () => {
  const row = log(); row.prompt = 'PRIVATE_BODY'; row.credentials = 'PRIVATE_KEY';
  row.attempts[0].usage.rawUsage = { loginToken: 'PRIVATE_LOGIN' };
  row.attempts[0].toolPayload = 'PRIVATE_TOOL';
  const report = run({ logs: [[row]] });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/);
  assert.doesNotMatch(JSON.stringify(projectLog(row)), /PRIVATE_/);
  row.attempts[0].model = { prompt: 'PRIVATE_MODEL_PAYLOAD' };
  assert.doesNotMatch(JSON.stringify(run({ logs: [[row]] })), /PRIVATE_/);
  row.attempts = {};
  assert.equal(total(run({ logs: [[row]] })), null);
  assert.equal(total(run({ logs: [{ summary: { totalTokens: 999999 } }] })), null);
  assert.match(renderUsageMarkdown(report), /Actual billing and subscription quota: unavailable/);
  assert.match(renderUsageMarkdown(report), /r-build:1/);
});

test('CLI reads real export fixtures, emits both reports, and protects inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'usage-audit-'));
  try {
    const cli = new URL('../scripts/audit-usage.mjs', import.meta.url).pathname;
    const fixtures = new URL('./fixtures/usage-audit/', import.meta.url).pathname;
    const output = join(directory, 'report.json'), markdown = join(directory, 'report.md');
    const args = [cli, '--root', 'main', '--cutoff', '2026-09-09T13:00:00Z', '--history', `${fixtures}history.json`,
      '--roles', `${fixtures}roles.json`, '--json', output, '--markdown', markdown, `${fixtures}logs.json`];
    execFileSync(process.execPath, args);
    assert.equal(total(JSON.parse(await readFile(output, 'utf8'))), 2400);
    assert.match(await readFile(markdown, 'utf8'), /byAgentRoleModelParent/);
    assert.notEqual(spawnSync(process.execPath, args).status, 0);
    const bad = join(directory, 'bad.json'); await writeFile(bad, '{"prompt":"PRIVATE_BODY",');
    const result = spawnSync(process.execPath, [cli, '--root', 'main', '--cutoff', '2026-09-09T13:00:00Z', bad], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /PRIVATE_BODY/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('live CLI uses only bounded read-only commands and filters attempts after collection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'usage-live-'));
  try {
    const cli = new URL('../scripts/audit-usage.mjs', import.meta.url).pathname;
    const fixturePath = new URL('./fixtures/usage-audit/logs.json', import.meta.url).pathname;
    const trace = join(directory, 'trace.jsonl');
    const executable = join(directory, 'opencodex');
    await writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args)+'\\n');
if (args.length === 1 && args[0] === '--version') console.log('opencodex 2.46.0');
else if (args[0] === 'logs') console.log(fs.readFileSync(${JSON.stringify(fixturePath)}, 'utf8'));
else process.exit(99);
`, { mode: 0o700 });
    const raw = execFileSync(process.execPath, [cli, '--root', 'main', '--cutoff', '2026-09-09T13:00:00Z',
      '--live', '--limit', '10', '--model', 'claude-fable-5-1', '--provider', 'anthropic'],
    { encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}` } });
    const report = JSON.parse(raw);
    assert.equal(report.runtime.version, 'opencodex 2.46.0');
    assert.equal(total(report), 1220);
    assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse), [
      ['--version'], ['logs', '--json', '--conversation', 'main', '--limit', '10'],
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
