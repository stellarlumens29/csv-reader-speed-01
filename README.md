# Fast csv-reader drop-in

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/stellarlumens29/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/stellarlumens29/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own csv-reader 1.0.0, entered in the
[Read broken CSV files faster](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
bounty on [make.fun](https://make.fun).

## What it is

`solve.js` exports `run(input)`, which returns exactly what csv-reader 1.0.0
returns for the same `{text, header}` input: `{columns, rows, errors}` under
csv-reader's written broken-row policy (BOM dropped, LF/CRLF record ends,
stray CRs dropped with a `stray_cr` error, quoted fields with `""` escapes
and LF-normalised line breaks, `quote_junk` after a closing quote,
`unterminated_quote` re-read as unquoted, `short_row` padding and `long_row`
cutting to the first record's width, all errors in encounter order).

`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## How it is faster

The reference walks the text one character at a time and grows each field
one character at a time. This module jumps delimiter to delimiter instead:

- a record whose physical line holds no quote is the whole line: one
  `split(',')`, with stray CRs dropped first;
- other fields are cut out with `slice` between the nearest comma / line
  break found by `indexOf`, and CRs are only looked for inside that slice,
  so a stray CR far ahead is never scanned for;
- a quoted field finds its closing quote with `indexOf('"')` (skipping
  doubled quotes), slices the contents out whole, and only does extra work
  when the contents actually hold a line break or a doubled quote.

Nothing is cached between cases; `run` is pure and answers each case alone.
No dependencies, no network, no WebAssembly, no native code.

## Measured speed

On the competition's practice set (6 cases, ~10.2 MB of CSV), same machine,
parse time only (CPU, mean of 5 runs):

| | CPU time |
|---|---|
| csv-reader 1.0.0 (reference) | ~704 ms |
| this entry | ~226 ms |
| speedup | **~3.1x** |

Correctness: identical output to csv-reader 1.0.0 on all 6 practice cases,
plus ~6,100 hand-written and fuzzed broken-CSV inputs (malformed rows,
quoted fields, embedded newlines, stray CRs, unterminated quotes,
quote junk, BOM, empty input) with zero differences.

## Files

- `solve.js` — the fast reader (ES module, dependency-free)
- `main.ts` — the harness driver
- `package.json` — `{"type": "module"}`
- `LICENSE` — MIT
