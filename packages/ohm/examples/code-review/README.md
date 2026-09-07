# Independent code review

Install this optional plugin with `ohm plugins install PATH`, then run `/refresh`.
`/review` independently reviews tracked staged and unstaged changes against
`HEAD`. The `code_review` tool also accepts `scope: "staged"` to review only
the index. Untracked files are excluded until staged; diffs over 48 KiB are
rejected instead of silently truncated. Findings return to the calling tool
or command with the saved session path.

Give the reviewer a small, coherent change. Each finding should identify a file
and line, reachable trigger, concrete impact, supporting evidence, and a
corrective direction. Code inspection is not a claimed test run. Unsupported
questions and missing verification belong outside the findings list; no
supported defect is a valid result, not a guarantee that the change is bug-free.
The prompt treats diffs, repository files, and previous reports as data, and
stops at the review scope or execution limit rather than inventing findings.

The plugin owns one ordinary `RpcClient` from `ohm/interfaces`. It selects
the active model/provider, allows only `read`, `grep`, `find`, and `ls`, and
sets an eight-step limit, a 2,048-output-token limit, and a 60-second deadline.
The child has no shell or write tool and does not load plugins or context
files. These choices are plugin policy, not a built-in subagent service or
OS isolation. The child resolves its own installed provider configuration and
credentials; in-memory providers from another host are not inherited. Review
requests send source code to the selected provider and can cost money. Confirm
that this provider is appropriate for the repository before requesting a review;
the timeout and token limits are not a currency budget.

The process closes on completion, cancellation, timeout, or plugin refresh.
The session remains in this plugin's private `reviews` directory. The
configuration store remembers the last session using an atomic compare-and-swap
write. `/review resume`, or tool action `resume`, opens that same session and
explicitly asks for continuation without rerunning the original diff command.
The reviewer must recheck previous findings against current files. Start a new
`/review` when you need a fresh diff; resume does not establish coverage of newly
changed files.
A crash can leave uncertain journal effects requiring normal session recovery;
the plugin reports the session path and does not invent a recovery decision.
Only one review runs per plugin generation. Previous journals remain
available at the session paths returned by earlier calls.

Run `ohm plugins test PATH`, then `ohm plugins verify PATH` against the source
package. The test command executes its declared npm test script.
Package tests substitute the public RPC client at the boundary, make no model
requests, and verify tool restrictions, output limits, cancellation, process
cleanup, and reuse of a saved session. Cross-mode repository tests also load the
real package through the SDK and RPC host. The checks verify prompt transport
and lifecycle behavior, not model obedience or review accuracy. Use a disposable
Git repository for a live provider review.
