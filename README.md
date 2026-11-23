# Fast makefun-site — site-generator-speed-01-run-20261122

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/0xtrava/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/0xtrava/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own **makefun-site 1.0.0**, entered in
[Build a static site faster, 22 November 2026](https://make.fun/competitions/site-generator-speed-01-run-20261122)
on [make.fun](https://make.fun). `solve.js` is a dependency-free ES module
whose `run(input)` returns byte-for-byte what makefun-site 1.0.0's `build`
returns for every case; `main.ts` is the harness driver (reads
`/input/cases.json`, answers each case with `run`, writes
`/output/answers.json`).

## How it is faster

Same front matter, template dialect, Markdown subset, slug rule and report as
makefun-site — only the work is leaner:

- **Bulk HTML escaping** — plain runs are escaped in one native replace
  instead of once per character.
- **Fused Markdown pass** — lexing and rendering happen in one scan over the
  lines, with no token objects and no per-block allocations; inline markup
  jumps between special characters with a single regex scan.
- **Manual front-matter parsing** — the body is never split and re-joined;
  only the front-matter lines are scanned.
- **Cached slugify** with an ASCII fast path (NFKD is the identity on ASCII),
  and each page's card (word count, excerpt) computed once instead of per
  render.
- **Compiled templates** — each template is compiled once per build into a
  plain JS function (direct scope/property reads, string accumulation), with
  the AST interpreter as fallback; loop scopes are prototype chains reused
  across iterations.
- V8 incremental marking off, as the house baseline runs
  (`--no-incremental-marking`).

Practice set (3 cases, 250–480 sources each): all 3 identical to makefun-site
1.0.0, at roughly **3.5× less CPU time** than the house baseline on this
machine (trimmed mean over repeated runs; see the submission's grade).

## Layout

- `solve.js` — the entry: `export function run(input)`.
- `main.ts` — the harness driver.
- `LICENSE` — MIT.
