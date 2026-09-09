#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRecord, transition, validateRecord, assignmentStatus, assignmentBrief } from "./lib/assignment-record.mjs";

try {
  const [command, id, ...extra] = process.argv.slice(2);
  if (!["init", "apply", "validate", "status", "brief"].includes(command) || extra.length || (command === "brief" && !id) || (id && !["brief", "status"].includes(command))) {
    throw new Error("Usage: assignment-record.mjs init|apply|validate|status [id]|brief <id> < input.json");
  }
  const input = JSON.parse(readFileSync(0, "utf8"));
  let output;
  switch (command) {
    case "init": output = createRecord(input); break;
    case "apply": output = transition(input.record, input.event); break;
    case "validate": output = validateRecord(input); break;
    case "status": output = id ? assignmentStatus(input, id) : validateRecord(input).assignments.map((entry) => assignmentStatus(input, entry.id)); break;
    case "brief": output = assignmentBrief(input, id); break;
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
}
