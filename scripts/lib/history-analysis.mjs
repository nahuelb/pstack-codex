const list = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
const present = value => value !== null && value !== undefined;
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const identity = value => typeof value === 'string' && value.length > 0;
const key = (...parts) => JSON.stringify(parts);
const stable = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

export function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000;
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function unionIntervals(intervals) {
  const result = [];
  for (const [start, end] of intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a)
    .map(span => [...span]).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
const length = intervals => unionIntervals(intervals).reduce((sum, [a, b]) => sum + b - a, 0);
export function subtractIntervals(intervals, covered) {
  const result = [];
  const masks = unionIntervals(covered);
  for (const [start, end] of unionIntervals(intervals)) {
    let cursor = start;
    for (const [a, b] of masks) {
      if (b <= cursor || a >= end) continue;
      if (a > cursor) result.push([cursor, a]);
      cursor = Math.max(cursor, Math.min(end, b));
    }
    if (cursor < end) result.push([cursor, end]);
  }
  return result;
}
const metric = intervals => ({ intervals: unionIntervals(intervals), durationMs: length(intervals), grade: 'derived' });
const responseTypes = new Set(['modelResponse', 'response', 'tokenUsage']);
const fields = ['model', 'reasoningEffort', 'serviceTier', 'modelProvider'];
const metadata = value => Object.fromEntries(fields.map(field => [field, value?.[field] ?? null]));
const toolTypes = new Set(['commandExecution', 'mcpToolCall', 'collabAgentToolCall', 'dynamicToolCall', 'webSearch', 'toolCall']);
const classes = new Set(['active', 'wait', 'blocking', 'test', 'service-lifetime']);

export function analyzeHistory({ rootId, cutoff, snapshots, notes = [] }) {
  const cutoffMs = timestamp(cutoff);
  if (!identity(rootId) || cutoffMs === null || !Array.isArray(snapshots)) {
    throw new Error('Explicit rootId, cutoff (ISO with timezone or Unix seconds), and snapshots array are required');
  }
  const quarantine = [];
  const warnings = [];
  const catalog = [];
  const threads = new Map();
  const turns = new Map();
  const items = new Map();
  const reject = (reason, source, details = {}) => quarantine.push({ reason, source, ...details });
  function record(map, recordKey, value, source, immutable) {
    if (!map.has(recordKey)) map.set(recordKey, { value: { ...value }, sources: [source], invalid: false });
    else {
      const entry = map.get(recordKey);
      if (!entry.sources.includes(source)) entry.sources.push(source);
      for (const field of immutable) {
        if (present(entry.value[field]) && present(value[field]) && stable(entry.value[field]) !== stable(value[field])) {
          entry.invalid = true;
          reject('contradictory-record', source, { id: value.id, field });
        }
      }
      for (const [field, v] of Object.entries(value)) if (!present(entry.value[field])) entry.value[field] = v;
      if (['completed', 'interrupted', 'failed'].includes(value.status)) {
        if (['completed', 'interrupted', 'failed'].includes(entry.value.status) && entry.value.status !== value.status) {
          entry.invalid = true;
          reject('contradictory-terminal-status', source, { id: value.id });
        } else entry.value.status = value.status;
      }
    }
  }
  function importDocument(document, source, inherited = {}) {
    if (Array.isArray(document)) {
      document.forEach((value, index) => importDocument(value, `${source}#${index}`, inherited));
      return;
    }
    if (!document || typeof document !== 'object') return reject('unsupported-export', source);
    const threadBindings = [document.thread?.id, document.threadId, document.params?.threadId, inherited.threadId, document.result?.threadId, document.result?.thread?.id].filter(present);
    if (new Set(threadBindings).size > 1) return reject('contradictory-thread-binding', source);
    const turnBindings = [document.turnId, document.params?.turnId, inherited.turnId, document.result?.turnId].filter(present);
    if (new Set(turnBindings).size > 1) return reject('contradictory-turn-binding', source);
    if (document.result && !document.thread && !document.turns && !document.items) {
      return importDocument(document.result, source, { ...inherited, threadId: document.threadId ?? document.params?.threadId,
        turnId: document.turnId ?? document.params?.turnId, capturedAt: document.capturedAt, surface: document.method ?? document.surface });
    }
    if (identity(document.id) && typeof document.turns === 'number' && typeof document.items === 'number') {
      catalog.push({ id: document.id, source });
      if (!threads.has(document.id)) threads.set(document.id, { id: document.id, snapshots: [], sources: [], declaredAncestry: [], hasHistory: false });
      const actor = threads.get(document.id);
      actor.sources.push(source);
      actor.snapshots.push({ capturedAt: timestamp(document.capturedAt), metadata: metadata(document), source, sourceKind: 'index' });
      return;
    }
    const thread = document.thread;
    const threadId = thread?.id ?? document.threadId ?? document.params?.threadId ?? inherited.threadId;
    const capturedAt = timestamp(document.capturedAt ?? inherited.capturedAt);
    if (!identity(threadId)) return reject('missing-thread-binding', source);
    if ([document.threadId, document.params?.threadId, inherited.threadId].some(id => present(id) && id !== threadId)) {
      return reject('contradictory-thread-binding', source);
    }
    if (!threads.has(threadId)) threads.set(threadId, { id: threadId, snapshots: [], sources: [], declaredAncestry: [] });
    const actor = threads.get(threadId);
    actor.hasHistory = true;
    actor.sources.push(source);
    if (identity(thread?.parentThreadId)) actor.declaredAncestry.push({ id: thread.parentThreadId, source });
    if (thread) actor.snapshots.push({ capturedAt, metadata: metadata(thread), source });
    const turnList = [...list(thread?.turns), ...list(document.turns)];
    const pageTurnId = document.turnId ?? document.params?.turnId ?? inherited.turnId;
    const surface = document.method ?? document.surface ?? inherited.surface;
    if (surface === 'thread/turns/list') turnList.push(...list(document.data));
    if (document.turn) turnList.push(document.turn);
    function addItem(wrapper, turnId) {
      const item = wrapper?.item ?? wrapper;
      const boundTurn = wrapper?.turnId ?? turnId;
      if (!identity(item?.id) || !identity(boundTurn)) return reject('missing-item-or-turn-id', source);
      if ((wrapper.threadId && wrapper.threadId !== threadId) || (item.threadId && item.threadId !== threadId)
        || (item.turnId && item.turnId !== boundTurn) || (turnId && wrapper.turnId && wrapper.turnId !== turnId)) {
        return reject('cross-task-item', source, { id: item.id });
      }
      record(items, key(threadId, item.id), { ...item, threadId, turnId: boundTurn }, source,
        ['threadId', 'turnId', 'type', 'startedAt', 'completedAt', 'durationMs', 'responseId', 'usage', 'timingEvidence',
          'scope', 'servedModel', 'servedTier', 'cumulative', 'includesAgents', 'senderThreadId', 'receiverThreadIds', 'tool', 'model', 'modelProvider', 'reasoningEffort', 'serviceTier', 'arguments', 'command']);
    }
    for (const turn of turnList) {
      if (!identity(turn?.id) || (turn.threadId && turn.threadId !== threadId)) {
        reject('invalid-turn-binding', source, { id: turn?.id });
        continue;
      }
      record(turns, key(threadId, turn.id), { ...turn, threadId, items: undefined }, source,
        ['startedAt', 'completedAt', 'durationMs', 'threadId']);
      list(turn.items).forEach(item => addItem(item, turn.id));
    }
    list(document.items).forEach(item => addItem(item, pageTurnId));
    if (['thread/turns/items/list', 'thread/items/list'].includes(surface)) list(document.data).forEach(item => addItem(item, pageTurnId));
  }
  snapshots.forEach((snapshot, index) => importDocument(snapshot?.document ?? snapshot, snapshot?.source ?? `snapshot:${index}`));
  if (!threads.get(rootId)?.hasHistory) throw new Error('Root thread has no supported history export');
  function span(value, source) {
    const start = timestamp(value.startedAt);
    const end = timestamp(value.completedAt);
    if (start === null || end === null) return null;
    if (end < start) { reject('reversed-span', source, { id: value.id }); return null; }
    if (start >= cutoffMs) return null;
    return [start, Math.min(end, cutoffMs)];
  }
  const owners = new Map();
  for (const [kind, map] of [['turn', turns], ['item', items]]) {
    for (const entry of map.values()) {
      const idKey = key(kind, entry.value.id);
      if (!owners.has(idKey)) owners.set(idKey, []);
      owners.get(idKey).push(entry);
    }
  }
  for (const group of owners.values()) if (new Set(group.map(e => e.value.threadId)).size > 1) {
    for (const entry of group) { entry.invalid = true; reject('cross-task-id-collision', entry.sources[0], { id: entry.value.id }); }
  }
  const responseOwners = new Map();
  for (const entry of items.values()) {
    const i = entry.value;
    if (!responseTypes.has(i.type) || !identity(i.responseId)) continue;
    if (!responseOwners.has(i.responseId)) responseOwners.set(i.responseId, []);
    responseOwners.get(i.responseId).push(entry);
  }
  for (const group of responseOwners.values()) {
    const conflicting = ['threadId', 'turnId', 'usage', 'servedModel', 'servedTier', 'scope', 'cumulative', 'includesAgents']
      .some(field => new Set(group.map(({ value }) => value[field]).filter(present).map(stable)).size > 1);
    if (conflicting) for (const entry of group) {
      entry.invalid = true;
      reject('contradictory-response-id', entry.sources[0], { id: entry.value.responseId });
    }
  }
  const included = new Set([rootId]);
  const edges = [];
  const candidates = [];
  for (const entry of items.values()) {
    const i = entry.value;
    const turn = turns.get(key(i.threadId, i.turnId));
    if (entry.invalid || !turn || turn.invalid) continue;
    if (i.type !== 'collabAgentToolCall' || i.tool !== 'spawnAgent' || i.status !== 'completed') continue;
    const turnStart = timestamp(turn.value.startedAt);
    const turnEnd = timestamp(turn.value.completedAt);
    const itemStart = timestamp(i.startedAt);
    const itemEnd = timestamp(i.completedAt);
    if ((turnStart !== null && turnEnd !== null && turnEnd < turnStart)
      || (itemStart !== null && itemEnd !== null && itemEnd < itemStart)
      || (itemStart !== null && turnEnd !== null && itemStart > turnEnd)
      || (itemEnd !== null && turnStart !== null && itemEnd < turnStart)) {
      reject('contradictory-spawn-timing', entry.sources[0], { id: i.id }); continue;
    }
    if (i.senderThreadId !== i.threadId || !Array.isArray(i.receiverThreadIds) || !i.receiverThreadIds.every(identity)) {
      reject('invalid-spawn-binding', entry.sources[0], { id: i.id }); continue;
    }
    const start = timestamp(i.startedAt) ?? timestamp(turn.value.startedAt);
    if (start === null || start >= cutoffMs) continue;
    for (const target of new Set(i.receiverThreadIds)) candidates.push({ from: i.threadId, to: target, itemId: i.id,
      turnId: i.turnId, requested: metadata(i), earliestPossibleSpawnMs: start,
      cutoffPlacement: (timestamp(i.completedAt) ?? timestamp(turn.value.completedAt) ?? Infinity) <= cutoffMs ? 'before' : 'unknown',
      sources: entry.sources });
  }
  const targetOwners = new Map();
  for (const edge of candidates) {
    if (!targetOwners.has(edge.to)) targetOwners.set(edge.to, new Set());
    targetOwners.get(edge.to).add(edge.from);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of candidates) {
      if (!included.has(edge.from) || edges.includes(edge)) continue;
      if (edge.to === rootId || targetOwners.get(edge.to).size !== 1) {
        if (!edge.rejected) reject('contradictory-spawn-ancestry', edge.sources[0], { id: edge.to });
        edge.rejected = true; continue;
      }
      edges.push(edge);
      if (!included.has(edge.to)) { included.add(edge.to); changed = true; }
    }
  }
  for (const [id, actor] of threads) if (!included.has(id)) reject('unrelated-thread', actor.sources[0], { id });
  const invalidThreads = new Set();
  for (const [id, thread] of threads) {
    if (!included.has(id) || id === rootId) continue;
    const delegators = edges.filter(edge => edge.to === id).map(edge => edge.from);
    for (const ancestry of thread.declaredAncestry) if (!delegators.includes(ancestry.id)) {
      invalidThreads.add(id);
      reject('contradictory-thread-ancestry', ancestry.source, { id });
    }
  }
  if (invalidThreads.size) {
    const reachable = new Set([rootId]);
    let growing = true;
    while (growing) {
      growing = false;
      for (const edge of edges) if (reachable.has(edge.from) && !invalidThreads.has(edge.from) && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        growing = true;
      }
    }
    for (let index = edges.length - 1; index >= 0; index--) {
      if (!reachable.has(edges[index].from) || invalidThreads.has(edges[index].from)) {
        reject('quarantined-spawn-source', edges[index].sources[0], { id: edges[index].itemId });
        edges.splice(index, 1);
      }
    }
    for (const id of included) if (!reachable.has(id)) included.delete(id);
  }
  let pruning = true;
  while (pruning) {
    pruning = false;
    const bounds = new Map([...included].map(id => [id, id === rootId ? -Infinity : Math.min(...edges.filter(edge => edge.to === id).map(edge => edge.earliestPossibleSpawnMs))]));
    for (let index = edges.length - 1; index >= 0; index--) {
      const edge = edges[index];
      const lower = bounds.get(edge.from) ?? Infinity;
      const origin = items.get(key(edge.from, edge.itemId));
      const turn = turns.get(key(edge.from, edge.turnId));
      const itemEnd = timestamp(origin?.value.completedAt);
      const turnEnd = timestamp(turn?.value.completedAt);
      if (!included.has(edge.from) || invalidThreads.has(edge.from) || !turn || turn.invalid || origin?.invalid
        || (itemEnd !== null && itemEnd < lower) || (turnEnd !== null && turnEnd < lower)) {
        reject('quarantined-spawn-source', edge.sources[0], { id: edge.itemId });
        edges.splice(index, 1);
        pruning = true;
      } else if (edge.earliestPossibleSpawnMs < lower) {
        edge.earliestPossibleSpawnMs = lower;
        pruning = true;
      }
    }
    const reachable = new Set([rootId]);
    let growing = true;
    while (growing) {
      growing = false;
      for (const edge of edges) if (reachable.has(edge.from) && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        growing = true;
      }
    }
    for (const id of included) if (!reachable.has(id)) { included.delete(id); pruning = true; }
  }
  const responses = new Map();
  const actors = [];
  for (const id of [...included].sort()) {
    const actor = invalidThreads.has(id) ? undefined : threads.get(id);
    const incoming = edges.filter(edge => edge.to === id);
    const lowerBound = id === rootId ? -Infinity : Math.min(...incoming.map(edge => edge.earliestPossibleSpawnMs));
    const turnSpans = [];
    const turnRows = [];
    const observed = Object.fromEntries(['active', 'wait', 'blocking', 'test', 'service-lifetime', 'unknown'].map(c => [c, []]));
    const tools = { cumulativeDurationMs: 0, durationReceiptCount: 0, missingDurationCount: 0, excludedAtCutoffCount: 0,
      requestedSleepMs: 0, byClassification: Object.fromEntries(Object.keys(observed).map(c => [c, 0])),
      coverage: 'incomplete cumulative receipts; not a wall-time partition', receipts: [] };
    for (const entry of turns.values()) {
      const turn = entry.value;
      if (turn.threadId !== id || entry.invalid || !actor) continue;
      const interval = span(turn, entry.sources[0]);
      if (timestamp(turn.startedAt) !== null && timestamp(turn.completedAt) !== null
        && timestamp(turn.completedAt) < timestamp(turn.startedAt)) {
        warnings.push({ reason: 'missing-or-invalid-turn-span', threadId: id, turnId: turn.id });
        continue;
      }
      if (interval && interval[1] < lowerBound) {
        reject('turn-before-spawn', entry.sources[0], { id: turn.id }); continue;
      }
      const clipped = interval && [Math.max(interval[0], lowerBound), interval[1]];
      if (clipped) turnSpans.push(clipped);
      turnRows.push({ id: turn.id, interval: clipped, status: turn.status ?? 'unknown', sources: entry.sources });
      if (!interval && timestamp(turn.startedAt) !== null && timestamp(turn.startedAt) >= cutoffMs) continue;
      if (!interval) warnings.push({ reason: 'missing-or-invalid-turn-span', threadId: id, turnId: turn.id });
    }
    const eligibleTurns = new Map(turnRows.map(row => [row.id, row]));
    const eligibleItems = new Map();
    for (const entry of items.values()) {
      const i = entry.value;
      if (i.threadId !== id || entry.invalid || !actor) continue;
      const row = eligibleTurns.get(i.turnId);
      const nativeTurn = turns.get(key(id, i.turnId));
      if (!row) { reject('missing-or-quarantined-turn', entry.sources[0], { id: i.id }); continue; }
      const start = timestamp(i.startedAt);
      const end = timestamp(i.completedAt);
      if ((start !== null && start >= cutoffMs) || (timestamp(nativeTurn.value.startedAt) ?? -Infinity) >= cutoffMs) continue;
      const interval = span(i, entry.sources[0]);
      if (start !== null && end !== null && end < start) continue;
      const turnStart = timestamp(nativeTurn.value.startedAt);
      const turnEnd = timestamp(nativeTurn.value.completedAt);
      if ((start !== null && turnEnd !== null && start > turnEnd)
        || (end !== null && turnStart !== null && end < turnStart) || (end !== null && end < lowerBound)) {
        reject('item-outside-turn', entry.sources[0], { id: i.id }); continue;
      }
      if (interval && row.interval && Math.min(interval[1], row.interval[1]) < Math.max(interval[0], row.interval[0])) {
        reject('item-outside-turn', entry.sources[0], { id: i.id }); continue;
      }
      if (responseTypes.has(i.type)) {
        const total = i.usage?.total_tokens ?? i.usage?.totalTokens;
        const beforeCutoff = end !== null ? end <= cutoffMs : (turnEnd ?? Infinity) <= cutoffMs;
        if (!identity(i.responseId) || !nonnegative(total) || !Number.isSafeInteger(total) || i.scope !== 'response'
          || !beforeCutoff || i.cumulative === true || i.includesAgents === true) {
          reject('unusable-native-token-receipt', entry.sources[0], { id: i.id }); continue;
        }
      }
      eligibleItems.set(i.id, { entry, row, nativeTurn, interval, end });
    }
    for (const { entry, row, nativeTurn, interval, end } of eligibleItems.values()) {
      const i = entry.value;
      const classification = classes.has(i.timingEvidence?.classification) && identity(i.timingEvidence?.sourceItemId)
        && eligibleItems.has(i.timingEvidence.sourceItemId)
        ? i.timingEvidence.classification : 'unknown';
      if (interval && row.interval) {
        const bounded = [Math.max(interval[0], row.interval[0]), Math.min(interval[1], row.interval[1])];
        if (bounded[1] >= bounded[0]) observed[classification].push(bounded);
        else reject('item-outside-turn', entry.sources[0], { id: i.id });
      }
      const beforeCutoff = end !== null ? end <= cutoffMs : (timestamp(nativeTurn.value.completedAt) ?? Infinity) <= cutoffMs;
      if (toolTypes.has(i.type)) {
        const duration = i.durationMs;
        if (!nonnegative(duration)) tools.missingDurationCount++;
        else if (!beforeCutoff) tools.excludedAtCutoffCount++;
        else {
          tools.durationReceiptCount++;
          tools.cumulativeDurationMs += duration;
          tools.byClassification[classification] += duration;
          tools.receipts.push({ id: i.id, turnId: i.turnId, durationMs: duration, classification, sources: entry.sources });
        }
        if (['sleep', 'clock.sleep', 'clock__sleep'].includes(i.tool) && nonnegative(i.arguments?.duration_ms) && beforeCutoff) {
          tools.requestedSleepMs += i.arguments.duration_ms;
        }
      }
      if (responseTypes.has(i.type)) {
        const usage = i.usage;
        const total = usage?.total_tokens ?? usage?.totalTokens;
        if (!identity(i.responseId) || !nonnegative(total) || !Number.isSafeInteger(total)
          || i.scope !== 'response' || !beforeCutoff || i.cumulative === true || i.includesAgents === true) {
          reject('unusable-native-token-receipt', entry.sources[0], { id: i.id }); continue;
        }
        const value = { id: i.responseId, threadId: id, turnId: i.turnId, total, usage,
          servedModel: i.servedModel ?? null, servedTier: i.servedTier ?? null };
        record(responses, i.responseId, value, entry.sources[0], ['threadId', 'turnId', 'total', 'usage', 'servedModel', 'servedTier']);
      }
    }
    const snapshotsByTime = actor?.snapshots ?? [];
    const latestTime = Math.max(...snapshotsByTime.map(s => s.capturedAt ?? -Infinity));
    const latest = snapshotsByTime.filter(s => (s.capturedAt ?? -Infinity) === latestTime);
    const latestMetadata = Object.fromEntries(fields.map(field => {
      const values = [...new Set(latest.map(s => s.metadata[field]).filter(present))];
      return [field, values.length === 1 ? values[0] : null];
    }));
    const conflicts = [];
    for (const field of fields) {
      const latestValues = [...new Set(latest.map(s => s.metadata[field]).filter(present))];
      if (latestValues.length > 1) conflicts.push({ field, kind: 'latest-metadata-conflict', values: latestValues });
      const requestedValues = [...new Set(incoming.map(e => e.requested[field]).filter(present))];
      if (requestedValues.length > 1) conflicts.push({ field, kind: 'requested-metadata-conflict', values: requestedValues });
      if (requestedValues.some(value => present(latestMetadata[field]) && value !== latestMetadata[field])) {
        conflicts.push({ field, kind: 'requested-vs-latest', requested: requestedValues, latest: latestMetadata[field] });
      }
    }
    const intervals = unionIntervals(turnSpans);
    const envelope = intervals.length ? [[intervals[0][0], intervals.at(-1)[1]]] : [];
    actors.push({ id, kind: id === rootId ? 'main' : 'agent', historyAvailable: Boolean(actor?.hasHistory),
      requested: incoming.map(e => ({ itemId: e.itemId, ...e.requested })), latestMetadata,
      latestMetadataCapturedAtMs: Number.isFinite(latestTime) ? latestTime : null, metadataConflicts: conflicts,
      metadataSources: latest.map(s => ({ source: s.source, kind: s.sourceKind ?? 'thread' })), servedModel: null, servedTier: null,
      turnSpanCoverage: { observed: intervals.length, missing: turnRows.filter(row => !row.interval).length,
        completeness: 'unknown; exported snapshots may omit history' },
      turns: turnRows, turnUnion: metric(intervals), turnEnvelope: metric(envelope),
      betweenTurnGaps: metric(subtractIntervals(envelope, intervals)),
      withinTurnUnobserved: metric(subtractIntervals(intervals, Object.values(observed).flat())),
      withinTurnWithoutActivityClassification: metric(subtractIntervals(intervals,
        ['active', 'wait', 'blocking', 'test'].flatMap(c => observed[c]))),
      observed: Object.fromEntries(Object.entries(observed).map(([c, spans]) => [c, metric(spans)])),
      tools, actualTokens: null, tokenCoverage: 'unknown', tokenReceipts: [] });
  }
  for (const actor of actors) {
    const receipts = [...responses.values()].filter(e => !e.invalid && e.value.threadId === actor.id)
      .map(e => ({ ...e.value, sources: e.sources }));
    actor.tokenReceipts = receipts;
    if (receipts.length) {
      actor.actualTokens = receipts.reduce((sum, r) => sum + r.total, 0);
      actor.tokenCoverage = 'native response receipts only; completeness unknown';
      const models = [...new Set(receipts.map(r => r.servedModel).filter(present))];
      const tiers = [...new Set(receipts.map(r => r.servedTier).filter(present))];
      actor.servedModel = models.length === 1 ? models[0] : null;
      actor.servedTier = tiers.length === 1 ? tiers[0] : null;
    }
  }
  const main = actors.find(actor => actor.id === rootId);
  const agents = actors.filter(actor => actor.id !== rootId);
  const allIntervals = actors.flatMap(actor => actor.turnUnion.intervals);
  const window = main.turnUnion.intervals.length ? [[main.turnUnion.intervals[0][0], cutoffMs]] : [];
  const mainGaps = main.betweenTurnGaps.intervals;
  const agentIntervals = agents.flatMap(a => a.turnUnion.intervals);
  const semanticNotes = [];
  for (const note of notes) {
    if (!note || !included.has(note.threadId) || !['why', 'blocker', 'readiness'].includes(note.kind) || typeof note.text !== 'string') {
      reject('unsupported-semantic-note', 'notes'); continue;
    }
    semanticNotes.push({ threadId: note.threadId, kind: note.kind, text: note.text, grade: 'supplemental' });
  }
  return { schemaVersion: 1, rootId, cutoffMs, timestampUnit: 'milliseconds since Unix epoch',
    sources: snapshots.map((s, i) => s?.source ?? `snapshot:${i}`), catalog, edges, actors,
    coverage: { mainHistoryAvailable: main.historyAvailable, expectedAgentCount: agents.length,
      exportedAgentCount: agents.filter(a => a.historyAvailable).length,
      agentsWithObservedTurnSpans: agents.filter(a => a.turnUnion.intervals.length).length,
      completeness: 'unknown; zero interval totals can mean missing evidence' },
    totals: { mainTurnUnion: main.turnUnion, agentTurnUnion: metric(agents.flatMap(a => a.turnUnion.intervals)),
      agentTurnSumMs: agents.reduce((sum, a) => sum + a.turnUnion.durationMs, 0),
      allTurnUnion: metric(allIntervals), auditWindow: metric(window),
      mainBetweenTurnGapsWithoutObservedAgents: metric(subtractIntervals(mainGaps, agentIntervals)),
      mainBetweenTurnGapsCoveredByAgents: metric(subtractIntervals(mainGaps, subtractIntervals(mainGaps, agentIntervals))),
      noObservedTurnWithinAuditWindow: metric(subtractIntervals(window, allIntervals)) },
    quarantine, warnings, semanticNotes,
    limits: ['Turn spans are not active-time estimates.', 'Gaps establish no activity, idle, or blocker classification.',
      'Tool durations are incomplete cumulative receipts, not a wall-time partition.',
      'Service lifetimes are separate from blocking and test intervals.',
      'Requested sleep is not observed wait.', 'Latest metadata is not served identity or historical configuration.',
      'Capture and attachment times never extend test or activity spans.', 'Missing token receipts mean unknown tokens.'] };
}

export function renderMarkdown(report) {
  const seconds = value => (value / 1000).toFixed(3);
  const escape = value => String(value).replace(/[|\r\n]/g, ' ');
  return [`# History timing audit`, '', `Root: ${escape(report.rootId)}. Cutoff: ${new Date(report.cutoffMs).toISOString()}.`, '',
    `Main turn union: ${seconds(report.totals.mainTurnUnion.durationMs)}s.`,
    `Agent turn union: ${seconds(report.totals.agentTurnUnion.durationMs)}s; sum: ${seconds(report.totals.agentTurnSumMs)}s.`, '',
    '| Thread | Turn union (s) | Native receipt tokens | Metadata conflicts |', '|---|---:|---:|---:|',
    ...report.actors.map(a => `| ${escape(a.id)} | ${seconds(a.turnUnion.durationMs)} | ${a.actualTokens ?? 'unknown'} | ${a.metadataConflicts.length} |`), '',
    `Exported agent histories: ${report.coverage.exportedAgentCount}/${report.coverage.expectedAgentCount}. Missing histories are not zero work.`, '',
    `Quarantined inputs: ${report.quarantine.length}. Warnings: ${report.warnings.length}.`, '',
    ...report.limits.map(limit => `- ${limit}`), ''].join('\n');
}
