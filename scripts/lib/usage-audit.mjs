import { createHash } from 'node:crypto';
import { analyzeHistory } from './history-analysis.mjs';

export const tokenFields = ['inputTokens', 'cachedInputTokens', 'cacheReadInputTokens',
  'cacheCreationInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const count = n => Number.isSafeInteger(n) && n >= 0;
const identifier = s => typeof s === 'string' && s.length > 0 && s.length <= 4096 && !/[\x00-\x1f\x7f]/.test(s);
const pick = (value, fields) => Object.fromEntries(fields.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const scalars = (value, fields) => Object.fromEntries(Object.entries(pick(value, fields))
  .map(([k, v]) => [k, v === null || ['string', 'number', 'boolean'].includes(typeof v) ? v : null]));
const stable = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const hashThreadId = id => createHash('sha256').update(id.trim()).digest('hex').slice(0, 32);
export function auditTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && Number.isFinite(new Date(value).valueOf()) ? value : null;
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function costOf(value) {
  const cost = value?.displayMetrics?.cost;
  const n = cost?.kind === 'value' ? cost.estimate?.cost?.total : null;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

export function projectLog(row) {
  const result = scalars(row, ['requestId', 'timestamp', 'conversationId', 'model', 'provider', 'requestedModel',
    'requestedEffort', 'effectiveEffort', 'resolvedModel', 'usageStatus', 'totalTokens', 'durationMs',
    'cumulative', 'includesAgents', 'scope']);
  result.usage = scalars(row?.usage, [...tokenFields, 'estimated', 'contextTotalTokens']);
  result.estimatedApiCostUsd = costOf(row);
  if (row?.attribution) result.attribution = scalars(row.attribution,
    ['version', 'threadId', 'parentThreadId', 'identityFormat', 'source']);
  if (Array.isArray(row?.attempts)) result.attempts = row.attempts.map(attempt => ({
    ...scalars(attempt, ['ordinal', 'model', 'provider', 'adapter', 'usageStatus', 'totalTokens', 'sendCount',
      'durationMs', 'requestedEffort', 'effectiveEffort', 'cumulative', 'includesAgents', 'scope']),
    usage: scalars(attempt?.usage, [...tokenFields, 'estimated', 'contextTotalTokens']),
    estimatedApiCostUsd: costOf(attempt),
  }));
  if (row?.attempts !== undefined && !Array.isArray(row.attempts)) result.invalidAttempts = true;
  return result;
}

export function usageTopology({ rootId, cutoff, snapshots = [] }) {
  if (!identifier(rootId) || auditTime(cutoff) === null) throw new Error('An exact root ID and timezone-qualified cutoff are required');
  if (!snapshots.length) return { actors: [{ id: rootId }], edges: [], quarantine: [] };
  return analyzeHistory({ rootId, cutoff: new Date(auditTime(cutoff)).toISOString(), snapshots });
}

function normalizedUsage(row, reject, evidence) {
  const usage = row.usage ?? {};
  const tokens = Object.fromEntries(tokenFields.map(k => [k, null]));
  let invalid = false;
  for (const field of tokenFields) {
    if (usage[field] == null) continue;
    if (count(usage[field])) tokens[field] = usage[field];
    else { reject('invalid-token-field', evidence, { field }); invalid = true; }
  }
  if (row.totalTokens != null && !count(row.totalTokens)) {
    reject('invalid-token-field', evidence, { field: 'totalTokens' }); invalid = true;
  }
  if (count(row.totalTokens) && tokens.totalTokens !== null && row.totalTokens !== tokens.totalTokens) {
    reject('conflicting-token-total', evidence); invalid = true;
  }
  if (invalid) return { tokens: Object.fromEntries(tokenFields.map(k => [k, null])), grade: 'missing', totalBasis: null };
  const explicit = tokens.totalTokens ?? row.totalTokens ?? null;
  const sum = tokens.inputTokens !== null && tokens.outputTokens !== null ? tokens.inputTokens + tokens.outputTokens : null;
  if (explicit !== null && sum !== null && explicit < sum) {
    reject('total-smaller-than-input-output', evidence);
    return { tokens: Object.fromEntries(tokenFields.map(k => [k, null])), grade: 'missing', totalBasis: null };
  }
  tokens.totalTokens = explicit ?? sum;
  if (tokens.totalTokens !== null && !count(tokens.totalTokens)) throw new Error('Token total exceeds safe integer range');
  const grade = tokenFields.every(k => tokens[k] === null) ? 'missing'
    : row.usageStatus === 'estimated' || usage.estimated === true ? 'estimated'
    : row.usageStatus === 'reported' ? 'reported' : 'missing';
  if (grade === 'missing') for (const field of tokenFields) tokens[field] = null;
  return { tokens, grade, totalBasis: grade === 'missing' ? null : explicit !== null ? 'native total' : sum !== null ? 'input + output' : null };
}

function metrics(rows) {
  const fields = {};
  for (const field of tokenFields) {
    fields[field] = {};
    for (const grade of ['reported', 'estimated']) {
      const known = rows.filter(r => r.grade === grade && r.tokens[field] !== null);
      const value = known.length ? known.reduce((n, r) => n + r.tokens[field], 0) : null;
      if (value !== null && !count(value)) throw new Error('Aggregate exceeds safe integer range');
      fields[field][grade] = { value, records: known.length };
    }
    fields[field].missingRecords = rows.length - fields[field].reported.records - fields[field].estimated.records;
  }
  return fields;
}

function groups(rows, keys) {
  const grouped = new Map();
  for (const row of rows) {
    const dimensions = Object.fromEntries(keys.map(k => [k, row[k]]));
    const key = stable(dimensions);
    if (!grouped.has(key)) grouped.set(key, { ...dimensions, rows: [] });
    grouped.get(key).rows.push(row);
  }
  const result = [...grouped.values()].map(({ rows: members, ...dimensions }) => ({ ...dimensions,
    records: members.length, firstRequestAt: new Date(Math.min(...members.map(r => r.timestamp))).toISOString(),
    lastRequestAt: new Date(Math.max(...members.map(r => r.timestamp))).toISOString(),
    metrics: metrics(members), evidence: members.map(r => r.id),
  })).sort((a, b) => Number(keys.some(k => a[k] === null)) - Number(keys.some(k => b[k] === null))
    || (b.metrics.totalTokens.reported.value ?? -1) - (a.metrics.totalTokens.reported.value ?? -1)
    || stable(pick(a, keys)).localeCompare(stable(pick(b, keys))));
  let lastTotal, rank, ranked = 0;
  return result.map(row => {
    const value = row.metrics.totalTokens.reported.value;
    if (value === null || keys.some(k => row[k] === null)) return { ...row, rank: null };
    ranked++;
    if (value !== lastTotal) rank = ranked;
    lastTotal = value;
    return { ...row, rank };
  });
}

export function auditUsage({ rootId, cutoff, since, snapshots = [], logs = [], roleBindings = [], model, provider, topology }) {
  const cutoffMs = auditTime(cutoff);
  const sinceMs = since === undefined ? 0 : auditTime(since);
  if (cutoffMs === null || sinceMs === null || sinceMs > cutoffMs) throw new Error('Invalid audit time window');
  const history = topology ?? usageTopology({ rootId, cutoff, snapshots });
  const quarantine = [...history.quarantine];
  const reject = (reason, evidence, detail = {}) => quarantine.push({ reason, evidence, ...detail });
  const ids = new Set(history.actors.map(a => a.id));
  const hashes = new Map([...ids].map(id => [hashThreadId(id), id]));
  const parents = new Map(history.edges.filter(e => e.cutoffPlacement === 'before').map(e => [e.to, e.from]));
  const bound = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, parent] of parents) if (bound.has(parent) && !bound.has(id)) { bound.add(id); changed = true; }
  }
  const resolveId = (id, format) => format === 'sha256-128' ? hashes.get(id) : format === 'raw' && ids.has(id) ? id : undefined;
  const roles = [];
  if (!Array.isArray(roleBindings)) throw new Error('Role bindings must be an array of explicit dispatch projections');
  for (const role of roleBindings) {
    if (!role || typeof role !== 'object') { reject('unbound-role-assignment', 'roles'); continue; }
    const edge = history.edges.find(e => e.itemId === role.dispatchItemId && e.from === role.parentThreadId && e.to === role.threadId);
    const from = role.from === undefined ? edge?.earliestPossibleSpawnMs : auditTime(role.from);
    const to = role.to === undefined ? cutoffMs : auditTime(role.to);
    if (!edge || !bound.has(role.threadId) || !identifier(role.role) || !identifier(role.source)
      || from == null || to == null || from > to || from < edge.earliestPossibleSpawnMs) {
      reject('unbound-role-assignment', role?.source ?? 'roles'); continue;
    }
    roles.push({ threadId: role.threadId, role: role.role, from, to, source: role.source, dispatchItemId: role.dispatchItemId });
  }
  const requests = new Map();
  const sources = [];
  let duplicateRequests = 0;
  logs.forEach((snapshot, index) => {
    const document = snapshot?.document ?? snapshot;
    const source = snapshot?.source ?? `logs:${index}`;
    const entries = Array.isArray(document) ? document : document?.logs;
    if (!Array.isArray(entries)) { reject('unsupported-log-export', source); return; }
    sources.push({ source, rows: entries.length, ...scalars(document,
      ['total', 'generatedAt', 'historyTruncated', 'entriesTruncated', 'reset']), completeness: 'partial; retained log slice only' });
    entries.forEach((raw, rowIndex) => {
      const row = projectLog(raw);
      const evidence = `${source}#logs/${rowIndex}`;
      if (!identifier(row.requestId)) { reject('missing-request-id', evidence); return; }
      const existing = requests.get(row.requestId);
      if (existing) {
        duplicateRequests++;
        existing.sources.push(evidence);
        if (stable(existing.row) !== stable(row)) {
          existing.invalid = true;
          reject('conflicting-request-snapshots', evidence, { requestId: row.requestId });
        }
      } else requests.set(row.requestId, { row, sources: [evidence], invalid: false });
    });
  });
  const rows = [];
  const requestCosts = [];
  let excludedByFilter = 0;
  for (const { row: request, sources: evidence, invalid } of requests.values()) {
    if (invalid) continue;
    const timestamp = auditTime(request.timestamp);
    if (timestamp === null) { reject('missing-request-time', evidence); continue; }
    if (timestamp < sinceMs || timestamp >= cutoffMs) { excludedByFilter++; continue; }
    const groupId = hashes.get(request.conversationId) ?? (ids.has(request.conversationId) ? request.conversationId : undefined);
    if (!groupId || !bound.has(groupId)) { reject('unrelated-conversation', evidence, { requestId: request.requestId }); continue; }
    if (groupId !== rootId && timestamp < Math.min(...history.edges.filter(e => e.to === groupId).map(e => e.earliestPossibleSpawnMs))) {
      reject('usage-before-group-spawn', evidence); continue;
    }
    if (request.cumulative === true || request.includesAgents === true || (request.scope && request.scope !== 'request')) {
      reject('non-request-counter', evidence); continue;
    }
    let threadId = null;
    const attribution = request.attribution;
    if (attribution) {
      const candidate = resolveId(attribution.threadId, attribution.identityFormat);
      const parent = attribution.parentThreadId == null ? null : resolveId(attribution.parentThreadId, attribution.identityFormat);
      if (attribution.version !== 1 || attribution.source !== 'thread-id' || !candidate || !bound.has(candidate)
        || (candidate !== rootId && parents.get(candidate) !== parent) || (candidate === rootId && parent !== null)
        || (groupId !== candidate && groupId !== parent)) {
        reject('invalid-thread-attribution', evidence); continue;
      }
      threadId = candidate;
    }
    if (threadId !== null && threadId !== rootId) {
      const edges = history.edges.filter(e => e.to === threadId);
      if (timestamp < Math.min(...edges.map(e => e.earliestPossibleSpawnMs))) {
        reject('usage-before-spawn', evidence); continue;
      }
    }
    const matches = roles.filter(role => role.threadId === threadId && role.from <= timestamp && timestamp < role.to);
    const roleNames = [...new Set(matches.map(r => r.role))];
    if (roleNames.length > 1) reject('conflicting-role-assignments', evidence, { threadId });
    const role = roleNames.length === 1 ? roleNames[0] : null;
    if (request.invalidAttempts) { reject('invalid-attempts', evidence); continue; }
    const attempts = Array.isArray(request.attempts) && request.attempts.length ? request.attempts : [request];
    const hasAttempts = attempts[0] !== request;
    const ordinals = new Set(attempts.map(a => a.ordinal));
    if (hasAttempts && (ordinals.size !== attempts.length || attempts.some(a => !count(a.ordinal) || a.ordinal < 1))) {
      reject('invalid-attempt-ordinals', evidence); continue;
    }
    let selectedAttempts = 0;
    for (const attempt of attempts) {
      const observedModel = identifier(attempt.model) ? attempt.model : null;
      const observedProvider = identifier(attempt.provider) ? attempt.provider : null;
      if ((model && observedModel !== model) || (provider && observedProvider !== provider)) { excludedByFilter++; continue; }
      if (attempt.cumulative === true || attempt.includesAgents === true || (attempt.scope && !['request', 'attempt'].includes(attempt.scope))) {
        reject('non-attempt-counter', evidence); continue;
      }
      const id = `${request.requestId}:${hasAttempts ? attempt.ordinal : 'request'}`;
      const usage = normalizedUsage(attempt, reject, id);
      selectedAttempts++;
      rows.push({ id, requestId: request.requestId, ordinal: hasAttempts ? attempt.ordinal : null,
        timestamp, rootId, conversationGroup: groupId,
        parentTask: threadId === rootId ? rootId : threadId ? parents.get(threadId) : null,
        threadId, role, model: observedModel, provider: observedProvider,
        modelEvidence: 'OpenCodex attempt route; not independent proof of backend identity',
        resolvedModel: hasAttempts ? null : request.resolvedModel ?? null,
        requestedModel: request.requestedModel ?? null,
        requestedEffort: attempt.requestedEffort ?? request.requestedEffort ?? null,
        effectiveEffort: attempt.effectiveEffort ?? request.effectiveEffort ?? null,
        usageStatus: attempt.usageStatus ?? 'unreported', ...usage,
        sendCount: count(attempt.sendCount) ? attempt.sendCount : null,
        retry: hasAttempts && attempt.ordinal > 1,
        recoveryCoverage: attempt.sendCount > 1 ? 'partial; internal sends lack separate receipts' : 'not established',
        estimatedApiCostUsd: attempt.estimatedApiCostUsd,
        evidence, identityEvidence: attribution ?? null,
        roleEvidence: matches.map(r => ({ role: r.role, source: r.source, dispatchItemId: r.dispatchItemId })),
      });
    }
    if (selectedAttempts) requestCosts.push({ requestId: request.requestId,
      estimatedApiCostUsd: selectedAttempts === attempts.length ? request.estimatedApiCostUsd : null,
      evidence, appliesTo: 'whole request; excluded when attempt filter selects a subset' });
  }
  const priced = rows.filter(r => r.estimatedApiCostUsd !== null);
  const summaryCosts = requestCosts.filter(r => r.estimatedApiCostUsd !== null);
  return { schemaVersion: 1, rootId, since: sinceMs ? new Date(sinceMs).toISOString() : null,
    cutoff: new Date(cutoffMs).toISOString(), filter: { model: model ?? null, provider: provider ?? null },
    accounting: 'OpenCodex normalized request attempts; input includes cache, output includes reasoning',
    sources, delegationEdges: history.edges.map(e => pick(e,
      ['from', 'to', 'itemId', 'sources', 'earliestPossibleSpawnMs', 'cutoffPlacement'])),
    coverage: { completeness: 'partial', requests: new Set(rows.map(r => r.requestId)).size,
      records: rows.length, duplicateRequests, excludedByFilter, reportedRecords: rows.filter(r => r.grade === 'reported').length,
      estimatedRecords: rows.filter(r => r.grade === 'estimated').length, missingRecords: rows.filter(r => r.grade === 'missing').length,
      attributedRecords: rows.filter(r => r.threadId !== null).length, roleAttributedRecords: rows.filter(r => r.role !== null).length,
      expectedAgents: bound.size - 1, agentsWithUsage: new Set(rows.filter(r => r.threadId && r.threadId !== rootId).map(r => r.threadId)).size,
      aggregateOnlyRecords: rows.filter(r => r.ordinal === null).length,
      internalRecoveryRecords: rows.filter(r => r.sendCount > 1).length },
    totals: metrics(rows),
    rankings: { byAgent: groups(rows, ['threadId']), byRole: groups(rows, ['role']), byModel: groups(rows, ['provider', 'model']),
      byConversationGroup: groups(rows, ['conversationGroup']),
      byParentTask: groups(rows, ['parentTask']), byAgentRoleModelParent: groups(rows, ['threadId', 'role', 'provider', 'model', 'parentTask']) },
    costs: { kind: 'estimated API equivalent; not actual billing or subscription quota',
      attemptEstimateUsd: priced.length ? priced.reduce((n, r) => n + r.estimatedApiCostUsd, 0) : null,
      pricedAttempts: priced.length, unpricedAttempts: rows.length - priced.length,
      requestEstimateUsd: summaryCosts.length ? summaryCosts.reduce((n, r) => n + r.estimatedApiCostUsd, 0) : null,
      pricedRequests: summaryCosts.length, requestEstimates: requestCosts,
      rule: 'Attempt and request estimates overlap. Never add them.', actualBilling: null, subscriptionQuota: null },
    rows, quarantine, limits: [
      'Rankings compare observed reported totals only; estimates remain separate and missing usage can change the order.',
      'Null actor or role means unattributed, never main-agent usage or zero usage.',
      'A grouped conversation ID proves group membership, not the requesting agent.',
      'Conversation grouping alone cannot establish the immediate delegating task; grouping and parent-task views remain separate.',
      'Role projections require reviewed assignment evidence. The tool validates dispatch binding, not the source text.',
      'Request timestamps bound observed requests, not agent active time. Cutoff is exclusive; ongoing requests may be absent.',
      'Native history receipts and account usage summaries are not added to this meter.',
      'Cumulative, context-only, and agent-inclusive counters do not provide additional per-request tokens.',
      'Resumed agents retain their identity; repeated exports deduplicate by request ID. Distinct retry requests still count.',
      'Nested usage counts once at its requesting agent and immediate delegating task; ancestor totals are alternative views.',
      'Historical logs without a separate thread identity cannot establish child-agent or role rankings.',
    ] };
}

export function renderUsageMarkdown(report) {
  const text = value => String(value ?? 'unattributed').replace(/[|\r\n]/g, ' ');
  const n = value => value ?? 'unavailable';
  const money = value => value === null ? 'unavailable' : value.toFixed(6);
  const lines = ['# Conversation token audit', '', `Main task: ${text(report.rootId)}. As of ${report.cutoff}.`, '',
    `Filter: provider=${text(report.filter.provider ?? 'all')}; model=${text(report.filter.model ?? 'all')}.`,
    `Coverage: partial. ${report.coverage.records} records; ${report.coverage.reportedRecords} reported, ${report.coverage.estimatedRecords} estimated, ${report.coverage.missingRecords} missing.`,
    `Agent attribution: ${report.coverage.attributedRecords}/${report.coverage.records}; role attribution: ${report.coverage.roleAttributedRecords}/${report.coverage.records}.`, '',
    `Internal recovery records: ${report.coverage.internalRecoveryRecords}; their per-send coverage is partial. Aggregate-only records: ${report.coverage.aggregateOnlyRecords}; retry coverage is unknown.`, '',
    '| Token field | Reported subtotal | Estimated subtotal | Missing records |', '|---|---:|---:|---:|',
    ...tokenFields.map(k => `| ${k} | ${n(report.totals[k].reported.value)} | ${n(report.totals[k].estimated.value)} | ${report.totals[k].missingRecords} |`), '',
    'Input includes cache reads and creation. Output includes reasoning. Detail fields are not extra tokens.', ''];
  for (const [name, groups] of Object.entries(report.rankings)) {
    lines.push(`## ${name}`, '', '| Rank | Identity | Reported total | Estimated total | Missing totals | First / last request (UTC) | Evidence |', '|---:|---|---:|---:|---:|---|---|',
      ...groups.map(g => `| ${n(g.rank)} | ${Object.entries(g).filter(([k]) => ['threadId', 'role', 'provider', 'model', 'parentTask', 'conversationGroup'].includes(k)).map(([k, v]) => `${k}=${text(v)}`).join('; ')} | ${n(g.metrics.totalTokens.reported.value)} | ${n(g.metrics.totalTokens.estimated.value)} | ${g.metrics.totalTokens.missingRecords} | ${g.firstRequestAt} / ${g.lastRequestAt} | ${g.evidence.map(text).join(', ')} |`), '');
  }
  lines.push(`Estimated API equivalent: ${money(report.costs.attemptEstimateUsd)} USD from attempts (${report.costs.pricedAttempts} priced).`,
    `Alternative request estimate: ${money(report.costs.requestEstimateUsd)} USD. Do not add these estimates. Actual billing and subscription quota: unavailable.`, '',
    '## Evidence', '', '| Record | Sources | Role sources |', '|---|---|---|',
    ...report.rows.map(r => `| ${text(r.id)} | ${r.evidence.map(text).join(', ')} | ${r.roleEvidence.map(e => text(e.source)).join(', ') || 'unavailable'} |`), '',
    `Quarantined inputs: ${report.quarantine.length}. See JSON for exclusions, per-field coverage, and receipt details.`, '',
    ...report.limits.map(l => `- ${l}`), '');
  return lines.join('\n');
}
