# @camunda8/tsc-api-changelog

Generate a structured API changelog between two git refs of a TypeScript SDK, using `tsc --noEmit` structural type checking. Zero false positives.

## How it works

Given a git repository with a generated types file (e.g. `src/gen/types.gen.ts`), this tool:

1. Extracts the types file from two git refs (baseline and current)
2. Generates value-level assignments like `const _: Current.Foo = {} as any as Stable.Foo`
3. Runs `tsc --noEmit` — TypeScript's structural type system catches every incompatibility
4. Parses and classifies tsc errors into a structured Markdown report

### Three-pass analysis

The tool runs three separate tsc passes to detect different dimensions of change:

| Pass | Technique | Detects |
|---|---|---|
| **Breaking** | `Current.Foo = {} as any as Stable.Foo` | Removed types, incompatible types |
| **Additive** | `DeepRequired<Current.Foo> = {} as any as DeepRequired<Stable.Foo>` | New properties added to existing types |
| **Removed** | `DeepRequired<Stable.Foo> = {} as any as DeepRequired<Current.Foo>` | Properties removed from existing types |

The `DeepRequired<T>` trick forces all properties to be required, so tsc reports missing properties that would otherwise be invisible due to structural subtyping.

### Role-aware direction

Types are classified as **request** or **response** based on naming conventions (e.g. `*Data`, `*Filter` → request; `*Response`, `*Error` → response). This determines the assignability direction:

- **Request types**: old input must work with new API → checks `Stable → Current`
- **Response types**: new output must satisfy old consumers → checks `Current → Stable`
- **Unknown**: checked in both directions

### Error summarization

Raw tsc error chains are summarized into one-liners:

| Category | Example |
|---|---|
| `enum-member-added` | `.status`: `StatusEnum` gained member `"ARCHIVED"` |
| `enum-member-removed` | `.type`: `TypeEnum` lost member `"UNSPECIFIED"` |
| `became-optional` | `.items`: became optional (was required `Result[]`) |
| `became-required` | `.name`: became required (was optional `string`) |
| `branded-type` | `.key.$eq`: `string` → branded `ProcessDefinitionKey` |
| `null-removed` | `.field`: `null` removed from union |
| `type-changed` | `.count`: `number` changed to `string` |

### Change classification

Changes are classified into five categories, distinguishing API-level from SDK-level impact:

| Category | Icon | Scope | Description |
|---|---|---|---|
| **API Breaking** | 🔴 | All consumers | Removed types, enum member removal, required field added to request, type changes |
| **SDK Breaking** | 🛡️ | TypeScript SDK only | Branded types (`string` → `TenantId`). The REST API still accepts plain strings. |
| **Hardened Contract** | 🟢 | Non-breaking | `null` removed from response union. The API now guarantees non-null; existing null checks still work. |
| **Exhaustiveness** | — | Non-breaking | Enum gained a new member. `switch` without `default` may warn. |
| **Additive** | — | Non-breaking | New optional properties added to existing types. |

### Operation grouping

The report groups changes by API operation (e.g. `GetDecisionInstance` groups `GetDecisionInstanceData`, `GetDecisionInstanceResponse`, `GetDecisionInstanceErrors`), derived from `@hey-api/openapi-ts` naming conventions.

## Usage

```bash
npx tsx src/cli.ts [--repo <path-or-url>] --old <ref> --new <ref> [options]
```

### Required options

| Option | Description |
|---|---|
| `--old <ref>` | Git ref for the stable/baseline version (tag, branch, SHA) |
| `--new <ref>` | Git ref for the current version. Use `WORKTREE` to read from the working directory. |

### Options

| Option | Default | Description |
|---|---|---|
| `--repo <path-or-url>` | `https://github.com/camunda/orchestration-cluster-api-js` | Local git repo path, or a git URL that will be cloned to a temporary directory |
| `--types-file <path>` | `src/gen/types.gen.ts` | Path to the types file within the repo |
| `--output <path>` | stdout | Output file path for the report |
| `--mode <mode>` | `migration` | `migration` (all changes) or `regression` (disallowed breaking changes only) |
| `--format <format>` | `markdown` | `markdown` or `json` |

### Examples

```bash
# Compare stable branch to main from the default repo URL
npx tsx src/cli.ts --old stable/8.8 --new main

# Compare using a local checkout
npx tsx src/cli.ts --repo ./orchestration-cluster-api-js --old stable/8.8 --new main

# Compare using an explicit remote URL (cloned to a temp directory)
npx tsx src/cli.ts --repo https://github.com/camunda/orchestration-cluster-api-js --old stable/8.8 --new main

# Compare against working directory (after regenerating from a different spec)
npx tsx src/cli.ts --repo ./orchestration-cluster-api-js --old stable/8.8 --new WORKTREE \
  --output reports/8.8-to-8.9.md

# Regression check (only disallowed breaking changes)
npx tsx src/cli.ts --repo ./my-sdk --old v1.0.0 --new v2.0.0 --mode regression

# JSON output
npx tsx src/cli.ts --repo ./my-sdk --old v1.0.0 --new v2.0.0 --format json
```

### Exit codes

- `0` — no breaking changes
- `1` — breaking changes detected

## Output

The tool writes a Markdown report to `<out-dir>/<stable-version>-><current-version>.md` with these sections:

1. **Summary** — counts table (baseline types, current types, API breaking, SDK breaking, hardened contract)
2. **Legend** — explains icons and annotations
3. **API Breaking Changes** — changes that affect all consumers of the REST API
4. **SDK Breaking Changes** — changes that only affect TypeScript SDK consumers (e.g. branded types)
5. **Hardened Contract** — response fields where `null` was removed (non-breaking improvement)
6. **Exhaustiveness** — enum members added (may affect exhaustive `switch` statements)
7. **Additive Changes** — new optional properties added to existing types
8. **New** — entirely new types and operations
9. **Changes by Operation** — all changes grouped by API operation name

## Project structure

```
src/
  cli.ts        — CLI entry point and argument parsing
  resolve.ts    — Extract types file from git refs via git show
  extract.ts    — Enumerate exported type names using the TS compiler API
  roles.ts      — Request/response role classification by naming heuristics
  check.ts      — Generate tsc check files, run three passes, parse output
  summarize.ts  — Pattern-based error summarizer (tsc chains → one-liners)
  report.ts     — Markdown report generation
```

## Requirements

- Node.js ≥ 20
- TypeScript ≥ 5.x (used as a peer via `npx`)
- The target repo must be a git repository with the types file committed on both refs
