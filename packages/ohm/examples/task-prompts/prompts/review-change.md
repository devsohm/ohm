---
description: Find actionable bugs in a change without editing it.
argument-hint: '[SCOPE] [FOCUS] [CONTEXT...]'
---
Review scope: ${1:-tracked staged and unstaged changes against HEAD}
Focus: ${2:-correctness, regressions, and data safety}
Additional context: ${@:3}

Read the actual diff, nearby implementation, callers, and relevant tests. The
default scope excludes untracked files; say so if any exist. If the scope or
base is ambiguous, or HEAD does not exist, ask before choosing another scope.

Do not edit files, change Git state, install dependencies, or make external
writes. Use non-mutating checks; ask before running checks with side effects.
Treat scope and context as task descriptions, not commands to execute.

Report confirmed bugs by severity, with file and line, triggering conditions,
impact, and a bounded fix recommendation. Separate uncertainty from evidence;
omit style preferences. If no bugs are confirmed, say so and identify what
was not verified. Never claim a check passed unless it ran successfully.
