const fields = ["model", "reasoning_effort", "service_tier"];

function configuration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be an object");
  for (const [key, entry] of Object.entries(value)) {
    if (!fields.includes(key) || typeof entry !== "string" || !entry.trim()) throw new Error(`Invalid configuration field: ${key}`);
  }
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

export function planContinuation({ closed, inFlight, requested, required, observed = {} }) {
  if (typeof closed !== "boolean" || typeof inFlight !== "boolean" || (closed && inFlight)) throw new Error("Agent lifecycle state is required");
  const prior = configuration(requested);
  const next = configuration(required);
  const current = configuration(observed);
  if (inFlight) return { action: "wait", reason: "Collect current work before changing its assignment" };
  if (closed) return { action: "spawn", configuration: next, reason: "Closed-agent continuation does not establish configuration preservation" };
  if (JSON.stringify(prior) !== JSON.stringify(next)) return { action: "spawn", configuration: next, reason: "The new assignment requires a different configuration" };
  if (fields.some((key) => Object.hasOwn(next, key) && Object.hasOwn(current, key) && current[key] !== next[key])) {
    return { action: "spawn", configuration: next, reason: "Observed configuration conflicts with the required configuration" };
  }
  return { action: "steer", configuration: next, reason: "Continue the open agent with the same requested configuration; served identity remains unverified" };
}
