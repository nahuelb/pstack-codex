---
name: principle-test-behavior-not-implementation
description: "Apply when writing or reviewing tests. Verify observable outcomes and identify assertions that cannot detect a relevant defect."
---

# Test behavior, not implementation

Call the code the way its users do and assert the result they observe against an independently chosen expected value.

Before keeping a test, name a relevant defect that would make it fail. Consider a missing implementation, incorrect output, or forbidden side effect. If the test still passes, improve its assertion or remove it when no required contract depends on it.

Inspect these patterns:

- Weak assertions that establish only existence or a broad type instead of the expected result.
- Mock-call counts without the payload or resulting state that matters to the caller.
- Expected values computed by the same implementation being tested.
- Constant pins that repeat an incidental implementation choice.
- Fixtures that assert only their own setup without exercising the subject.

Assertion names alone do not establish whether a test is weak. An absence can be the required behavior, such as no write after rejected input. Pair it with a valid-input case when that distinguishes a working guard from a missing implementation.

For example, call `slugify("Hello, World!")` and compare its output with `"hello-world"`. For a mock, check the meaningful payload or resulting state. For configuration, test the mechanism that consumes it.

Preserve required provenance pins, compatibility contracts, safety gates, table relations, and compile-time checks. This principle does not authorize removing a maintenance requirement because it checks data or instructions.
