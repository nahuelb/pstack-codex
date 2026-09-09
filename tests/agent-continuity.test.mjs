import assert from "node:assert/strict";
import test from "node:test";
import { planContinuation } from "../scripts/lib/agent-continuity.mjs";

const config = { model: "family-a", reasoning_effort: "high", service_tier: "requested-tier" };
const state = { closed: false, inFlight: false, requested: config, required: config };

test("open continuation preserves the complete requested settings without a served-model claim", () => {
  assert.equal(planContinuation(state).action, "steer");
  assert.deepEqual(planContinuation(state).configuration, config);
});

test("closed agents need fresh configured dispatch even when old metadata still matches", () => {
  const next = planContinuation({ ...state, closed: true, observed: config });
  assert.equal(next.action, "spawn");
  assert.deepEqual(next.configuration, config);
});

test("model, effort and tier drift each prevent silent reuse", () => {
  for (const key of Object.keys(config)) {
    assert.equal(planContinuation({ ...state, observed: { [key]: "different" } }).action, "spawn");
    assert.equal(planContinuation({ ...state, required: { ...config, [key]: "different" } }).action, "spawn");
  }
});

test("ongoing work is collected rather than replaced for a new assignment", () => {
  assert.equal(planContinuation({ ...state, inFlight: true, required: { model: "family-b" } }).action, "wait");
});

test("omitted settings preserve inheritance without inventing a default", () => {
  assert.deepEqual(planContinuation({ ...state, closed: true, requested: {}, required: {} }).configuration, {});
  assert.equal(planContinuation({ ...state, required: { model: config.model } }).action, "spawn");
  assert.throws(() => planContinuation({ ...state, required: { model: "" } }), /Invalid/);
  assert.throws(() => planContinuation({ ...state, closed: true, inFlight: true }), /lifecycle/);
});
