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
| `type-changed` | `.count`: `number` changed to `string` |

### Operation grouping

The report groups changes by API operation (e.g. `GetDecisionInstance` groups `GetDecisionInstanceData`, `GetDecisionInstanceResponse`, `GetDecisionInstanceErrors`), derived from `@hey-api/openapi-ts` naming conventions.

## Usage

```bash
npx tsx src/cli.ts <repo-path> <stable-ref> <current-ref> [options]
```

### Arguments

| Argument | Description |
|---|---|
| `repo-path` | Path to the git repository |
| `stable-ref` | Git ref for the baseline version (tag, branch, SHA) |
| `current-ref` | Git ref for the current version |

### Options

| Option | Default | Description |
|---|---|---|
| `--types-file <path>` | `src/gen/types.gen.ts` | Path to the types file within the repo |
| `--out-dir <path>` | `<repo-path>/changes` | Directory for the output report |

### Examples

```bash
# Compare stable branch to main
npx tsx src/cli.ts ./orchestration-cluster-api-js stable/8.8 main

# Custom types file location
npx tsx src/cli.ts /path/to/repo v1.0.0 v2.0.0 --types-file src/types.ts

# Write report to a specific directory
npx tsx src/cli.ts ./my-sdk stable/1.0 main --out-dir ./reports
```

### Exit codes

- `0` — no breaking changes
- `1` — breaking changes detected

## Output

The tool writes a Markdown report to `<out-dir>/<stable-version>-><current-version>.md` with these sections:

1. **Summary** — counts table (baseline types, current types, removed, incompatible, new, additive, removed properties)
2. **Removed Types** — types that no longer exist
3. **Incompatible Types** — types that exist in both versions but are structurally incompatible, with summarized error details
4. **Additive Property Changes** — new properties added to existing types
5. **Removed Properties** — properties removed from existing types
6. **New Types** — types only in the current version
7. **Changes by Operation** — all changes grouped by API operation name

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
