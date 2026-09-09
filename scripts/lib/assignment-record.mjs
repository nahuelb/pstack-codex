import path from "node:path";

const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const unique = (values) => new Set(values).size === values.length;
const states = ["queued", "working", "reported", "accepted", "rejected"];
const get = (record, id) => {
  const assignment = record.assignments.find((entry) => entry.id === id);
  requireValue(assignment, `Unknown assignment: ${id}`);
  return assignment;
};
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || a === "/" || b === "/";
const owned = (assignment) => [...assignment.sourcePaths, ...assignment.buildPaths];

function validateSpec(assignment) {
  for (const field of ["id", "owner", "goal", "verification", "stopCondition"]) {
    requireValue(nonempty(assignment[field]), `${field} is required`);
  }
  for (const field of ["sourcePaths", "buildPaths"]) {
    requireValue(Array.isArray(assignment[field]), `${field} must be an array`);
    for (const value of assignment[field]) {
      requireValue(nonempty(value) && path.posix.isAbsolute(value) && path.posix.normalize(value) === value && (value === "/" || !value.endsWith("/")) && !/[\0*?\[\]\\]/.test(value), `${field} must contain canonical absolute literal paths`);
    }
    requireValue(unique(assignment[field]), `Duplicate ${field}`);
  }
  requireValue(Array.isArray(assignment.provides), "provides must be an array");
  for (const contract of assignment.provides) {
    requireValue(nonempty(contract?.name) && nonempty(contract.description), "Contracts need name and description");
  }
  requireValue(unique(assignment.provides.map((entry) => entry.name)), "Duplicate contract name");
  requireValue(Array.isArray(assignment.requires), "requires must be an array");
  for (const dependency of assignment.requires) {
    requireValue(nonempty(dependency?.assignmentId) && positive(dependency.revision) && nonempty(dependency.contract), "Dependencies need assignmentId, revision and contract");
  }
  requireValue(unique(assignment.requires.map((entry) => `${entry.assignmentId}\0${entry.contract}`)), "Duplicate dependency");
}

function workBlockers(record, assignment, seen = new Set()) {
  if (seen.has(assignment.id)) return [];
  seen.add(assignment.id);
  const blockers = [];
  for (const dependency of assignment.requires) {
    const producer = get(record, dependency.assignmentId);
    const label = `${producer.id}@${dependency.revision}/${dependency.contract}`;
    if (producer.revision !== dependency.revision) blockers.push(`Stale dependency ${label}; current revision is ${producer.revision}`);
    else if (producer.state === "rejected" || !producer.ready.some((entry) => entry.name === dependency.contract)) blockers.push(`Contract unavailable: ${label}`);
    blockers.push(...workBlockers(record, producer, seen));
  }
  return blockers;
}

function integrationBlockers(record, assignment, seen = new Set()) {
  if (seen.has(assignment.id)) return [];
  seen.add(assignment.id);
  const blockers = assignment.state === "accepted" ? [] : [`Acceptance required: ${assignment.id}@${assignment.revision}`];
  for (const dependency of assignment.requires) blockers.push(...integrationBlockers(record, get(record, dependency.assignmentId), seen));
  return blockers;
}

export function validateRecord(record) {
  requireValue(record?.schemaVersion === 1 && positive(record.maxActive), "Expected schemaVersion 1 and positive maxActive");
  requireValue(Array.isArray(record.assignments), "assignments must be an array");
  requireValue(unique(record.assignments.map((entry) => entry?.id)), "Duplicate assignment ID");
  for (const assignment of record.assignments) {
    validateSpec(assignment);
    requireValue(positive(assignment.revision) && states.includes(assignment.state), "Invalid revision or state");
    requireValue(typeof assignment.acknowledged === "boolean", "acknowledged must be boolean");
    requireValue(Array.isArray(assignment.ready), "ready must be an array");
    requireValue(unique(assignment.ready.map((entry) => entry.name)), "Duplicate readiness");
    for (const ready of assignment.ready) {
      requireValue(assignment.provides.some((entry) => entry.name === ready.name) && nonempty(ready.evidence), "Readiness needs a declared contract and evidence");
    }
    if (assignment.state === "queued") requireValue(!assignment.acknowledged && assignment.ready.length === 0, "Queued assignment has progress");
    if (["reported", "accepted", "rejected"].includes(assignment.state)) {
      requireValue(assignment.result?.revision === assignment.revision && nonempty(assignment.result.summary) && nonempty(assignment.result.evidence), "Result must match the current revision and contain summary and evidence");
      requireValue(["completed", "blocked"].includes(assignment.result.outcome), "Result outcome is required");
      if (assignment.result.outcome === "completed") requireValue(assignment.ready.length === assignment.provides.length, "Completed result requires all provided contracts ready");
    } else requireValue(assignment.result === null, "Unexpected result");
    if (assignment.state === "accepted") requireValue(assignment.result.outcome === "completed", "Cannot accept blocked result");
    if (["accepted", "rejected"].includes(assignment.state)) {
      requireValue(assignment.acceptance?.revision === assignment.revision && assignment.acceptance.decision === assignment.state && nonempty(assignment.acceptance.evidence), "Invalid acceptance decision");
    } else requireValue(assignment.acceptance === null, "Unexpected acceptance");
    for (const dependency of assignment.requires) {
      const producer = get(record, dependency.assignmentId);
      requireValue(dependency.revision <= producer.revision, "Dependency references a future revision");
      if (dependency.revision === producer.revision) requireValue(producer.provides.some((entry) => entry.name === dependency.contract), `Unknown contract: ${dependency.contract}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(assignment) {
    requireValue(!visiting.has(assignment.id), `Dependency cycle: ${assignment.id}`);
    if (visited.has(assignment.id)) return;
    visiting.add(assignment.id);
    for (const dependency of assignment.requires) visit(get(record, dependency.assignmentId));
    visiting.delete(assignment.id);
    visited.add(assignment.id);
  }
  for (const assignment of record.assignments) visit(assignment);
  for (let i = 0; i < record.assignments.length; i++) {
    const assignment = record.assignments[i];
    for (const other of record.assignments.slice(i + 1)) {
      requireValue(!owned(assignment).some((a) => owned(other).some((b) => overlaps(a, b))), `Ownership conflict: ${assignment.id} and ${other.id}`);
    }
    if (assignment.state !== "queued") requireValue(workBlockers(record, assignment).length === 0, `Assignment ${assignment.id} has unavailable dependencies`);
  }
  requireValue(record.assignments.filter((entry) => entry.state === "working").length <= record.maxActive, "Active assignment limit exceeded");
  return record;
}

function fresh(spec, revision) {
  validateSpec(spec);
  const { id, owner, goal, verification, stopCondition, sourcePaths, buildPaths, provides, requires } = structuredClone(spec);
  return { id, revision, owner, goal, verification, stopCondition, sourcePaths, buildPaths, provides, requires,
    state: "queued", acknowledged: false, ready: [], result: null, acceptance: null };
}

export function createRecord({ maxActive, assignments }) {
  requireValue(Array.isArray(assignments), "assignments must be an array");
  return validateRecord({ schemaVersion: 1, maxActive, assignments: assignments.map((spec) => fresh(spec, 1)) });
}

function invalidateDependents(record, id) {
  const affected = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const assignment of record.assignments) {
      if (!affected.has(assignment.id) && assignment.requires.some((entry) => affected.has(entry.assignmentId))) {
        affected.add(assignment.id);
        changed = true;
      }
    }
  }
  record.assignments = record.assignments.map((entry) => affected.has(entry.id) && entry.id !== id ? fresh(entry, entry.revision + 1) : entry);
}

export function transition(record, event) {
  validateRecord(record);
  requireValue(event && nonempty(event.type), "Event type is required");
  const next = structuredClone(record);
  const assignment = get(next, event.assignmentId);
  requireValue(event.revision === assignment.revision, `Stale revision for ${assignment.id}; expected ${assignment.revision}`);
  switch (event.type) {
    case "revise": {
      requireValue(event.spec?.id === assignment.id, "Revision must preserve assignment ID");
      next.assignments[next.assignments.indexOf(assignment)] = fresh(event.spec, assignment.revision + 1);
      invalidateDependents(next, assignment.id);
      break;
    }
    case "start":
      requireValue(assignment.state === "queued", "Only queued assignments can start");
      requireValue(workBlockers(next, assignment).length === 0, "Required contracts are not ready");
      requireValue(next.assignments.filter((entry) => entry.state === "working").length < next.maxActive, "Active assignment limit reached");
      assignment.state = "working";
      break;
    case "acknowledge":
      requireValue(assignment.state !== "queued" && !assignment.acknowledged, "Acknowledgement requires a started, unacknowledged revision");
      assignment.acknowledged = true;
      break;
    case "ready":
      requireValue(assignment.state === "working", "Readiness requires working state");
      requireValue(assignment.provides.some((entry) => entry.name === event.contract), "Unknown contract");
      requireValue(!assignment.ready.some((entry) => entry.name === event.contract), "Contract already ready; revise to change it");
      requireValue(nonempty(event.evidence), "Readiness evidence is required");
      assignment.ready.push({ name: event.contract, evidence: event.evidence });
      break;
    case "result":
      requireValue(assignment.state === "working", "Result requires working state");
      requireValue(nonempty(event.summary) && nonempty(event.evidence), "Result summary and evidence are required");
      requireValue(event.outcome === undefined || ["completed", "blocked"].includes(event.outcome), "Invalid result outcome");
      if (event.outcome !== "blocked") requireValue(assignment.ready.length === assignment.provides.length, "Result requires all provided contracts ready");
      assignment.result = { revision: assignment.revision, outcome: event.outcome ?? "completed", summary: event.summary, evidence: event.evidence };
      assignment.state = "reported";
      break;
    case "accept":
    case "reject":
      requireValue(event.actor === "main", "Only the main agent records acceptance decisions");
      requireValue(assignment.state === "reported", "Acceptance decision requires a reported result");
      if (event.type === "accept") requireValue(assignment.result.outcome === "completed", "Cannot accept blocked result");
      requireValue(nonempty(event.evidence), "Acceptance evidence is required");
      assignment.state = event.type === "accept" ? "accepted" : "rejected";
      assignment.acceptance = { revision: assignment.revision, decision: assignment.state, evidence: event.evidence };
      if (event.type === "reject") invalidateDependents(next, assignment.id);
      break;
    default: throw new Error(`Unknown event type: ${event.type}`);
  }
  return validateRecord(next);
}

export function assignmentStatus(record, id) {
  validateRecord(record);
  const assignment = get(record, id);
  const blockers = workBlockers(record, assignment);
  const availableSlots = record.maxActive - record.assignments.filter((entry) => entry.state === "working").length;
  const startBlockers = [...blockers];
  if (assignment.state !== "queued") startBlockers.push(`Already ${assignment.state}`);
  if (availableSlots === 0) startBlockers.push("Active assignment limit reached");
  const integration = [...new Set([...blockers, ...integrationBlockers(record, assignment)])];
  return { id, revision: assignment.revision, state: assignment.state, acknowledged: assignment.acknowledged,
    ready: structuredClone(assignment.ready), result: structuredClone(assignment.result), acceptance: structuredClone(assignment.acceptance),
    availableSlots, canStart: startBlockers.length === 0, startBlockers,
    canIntegrate: integration.length === 0, integrationBlockers: integration };
}

export function assignmentBrief(record, id) {
  const status = assignmentStatus(record, id);
  const assignment = get(record, id);
  return { ...structuredClone(assignment), status,
    requiredContracts: assignment.requires.map((dependency) => {
      const producer = get(record, dependency.assignmentId);
      const current = producer.revision === dependency.revision;
      return { ...dependency, currentRevision: producer.revision,
        description: current ? producer.provides.find((entry) => entry.name === dependency.contract)?.description ?? null : null,
        evidence: current && producer.state !== "rejected" ? producer.ready.find((entry) => entry.name === dependency.contract)?.evidence ?? null : null };
    }),
    forbiddenPaths: record.assignments.filter((entry) => entry.id !== id).flatMap(owned) };
}
