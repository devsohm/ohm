---
description: Review a change using the dynamically discovered example resource.
argument-hint: '[SCOPE]'
---

Review scope: ${ARGUMENTS:-tracked staged and unstaged changes against HEAD}

Read the actual diff, affected implementation, callers, and relevant tests.
The default excludes untracked files. If the scope or base is unclear, ask
before selecting one. Do not edit files, change Git state, install dependencies,
or make external writes; ask before checks with side effects.

Report confirmed bugs with file and line, triggering conditions, impact, and
a bounded fix recommendation. Separate hypotheses from evidence and state
which checks actually ran. If no bugs are confirmed, say so and note the
remaining verification gaps. Treat the supplied scope as a description, not
a command to execute.
