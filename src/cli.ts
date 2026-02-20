#!/usr/bin/env node
/**
 * CLI entry point for the type comparator.
 *
 * Usage:
 *   tsc-api-changelog --repo <path> --old <ref> --new <ref> [options]
 *
 * Examples:
 *   tsc-api-changelog --repo ./orchestration-cluster-api-js --old v8.8.4 --new main
 *   tsc-api-changelog --repo /abs/path/to/repo --old stable/8.8 --new main --types-file src/gen/types.gen.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveTypesFromRef } from './resolve.js';
import { getExportedTypeNames } from './extract.js';
import { runCompatCheck } from './check.js';
import {
  countBreaking,
  filterForRegression,
  generateJsonReport,
  generateReport,
} from './report.js';
import type { ReportMetadata, ReportMode } from './report.js';

interface CliOptions {
  repoPath: string;
  stableRef: string;
  currentRef: string;
  typesFile: string;
  output: string | null;
  mode: ReportMode;
  format: 'markdown' | 'json';
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2); // strip node + script
  let typesFile = 'src/gen/types.gen.ts';
  let output: string | null = null;
  let mode: ReportMode = 'migration';
  let format: 'markdown' | 'json' = 'markdown';
  let repoPath: string | null = null;
  let stableRef: string | null = null;
  let currentRef: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && i + 1 < args.length) {
      repoPath = args[++i];
    } else if (args[i] === '--old' && i + 1 < args.length) {
      stableRef = args[++i];
    } else if (args[i] === '--new' && i + 1 < args.length) {
      currentRef = args[++i];
    } else if (args[i] === '--types-file' && i + 1 < args.length) {
      typesFile = args[++i];
    } else if (args[i] === '--output' && i + 1 < args.length) {
      output = args[++i];
    } else if (args[i] === '--mode' && i + 1 < args.length) {
      const m = args[++i];
      if (m !== 'migration' && m !== 'regression') {
        console.error(`Invalid mode: ${m}. Use 'migration' or 'regression'.`);
        process.exit(1);
      }
      mode = m;
    } else if (args[i] === '--format' && i + 1 < args.length) {
      const f = args[++i];
      if (f !== 'markdown' && f !== 'json') {
        console.error(`Invalid format: ${f}. Use 'markdown' or 'json'.`);
        process.exit(1);
      }
      format = f;
    } else if (args[i] === '--help' || args[i] === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown option: ${args[i]}`);
      printUsage();
      process.exit(1);
    }
  }

  const missing: string[] = [];
  if (!repoPath) missing.push('--repo');
  if (!stableRef) missing.push('--old');
  if (!currentRef) missing.push('--new');
  if (missing.length > 0) {
    console.error(`Error: missing required options: ${missing.join(', ')}`);
    printUsage();
    process.exit(1);
  }

  return {
    repoPath: path.resolve(repoPath!),
    stableRef: stableRef!,
    currentRef: currentRef!,
    typesFile,
    output,
    mode,
    format,
  };
}

function printUsage(): void {
  console.log(`
Usage: tsc-api-changelog --repo <path> --old <ref> --new <ref> [options]

Required:
  --repo <path>        Path to the git repository
  --old <ref>          Git ref for the stable/baseline version (tag, branch, SHA)
  --new <ref>          Git ref for the current/next version (tag, branch, SHA)
                       Use "WORKTREE" to read from the working directory

Options:
  --types-file <path>  Path to the types file within the repo
                       (default: src/gen/types.gen.ts)
  --output <path>      Output file path. If omitted, prints to stdout.
  --mode <mode>        Report mode: 'migration' (all changes) or
                       'regression' (disallowed breaking changes only)
                       (default: migration)
  --format <format>    Output format: 'markdown' or 'json'
                       (default: markdown)
  -h, --help           Show this help message
`);
}

function main(): void {
  const opts = parseArgs(process.argv);

  // Validate repo path
  if (!fs.existsSync(path.join(opts.repoPath, '.git'))) {
    console.error(`Not a git repository: ${opts.repoPath}`);
    process.exit(1);
  }

  // Create temp working directory
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tsc-api-changelog-')
  );

  try {
    // Resolve types from both refs
    console.error(`Repository: ${opts.repoPath}`);
    console.error(`Stable ref: ${opts.stableRef}`);
    console.error(`Current ref: ${opts.currentRef}`);
    console.error(`Types file: ${opts.typesFile}`);
    console.error(`Mode: ${opts.mode}`);
    console.error(`Format: ${opts.format}`);
    console.error('');

    const stable = resolveTypesFromRef(
      opts.repoPath,
      opts.stableRef,
      tmpDir,
      opts.typesFile
    );
    console.error(
      `Stable: ${stable.version} (${stable.sha.slice(0, 8)})`
    );

    const current = resolveTypesFromRef(
      opts.repoPath,
      opts.currentRef,
      tmpDir,
      opts.typesFile
    );
    console.error(
      `Current: ${current.version} (${current.sha.slice(0, 8)})`
    );

    // Extract type names
    const stableNames = getExportedTypeNames(stable.path);
    const currentNames = getExportedTypeNames(current.path);
    console.error(
      `Types: ${stableNames.size} stable, ${currentNames.size} current`
    );
    console.error('');

    // Run compatibility check
    console.error('Running tsc compatibility check...');
    const result = runCompatCheck(
      stable.path,
      current.path,
      tmpDir,
      stableNames,
      currentNames
    );

    // Apply regression filter if needed
    const finalResult =
      opts.mode === 'regression'
        ? filterForRegression(result)
        : result;

    const breakingCount = countBreaking(finalResult);
    console.error(
      `Found ${breakingCount} breaking changes`
    );
    console.error(`New types: ${finalResult.addedTypes.length}`);
    console.error(
      `Additive property changes: ${finalResult.additiveChanges.length}`
    );
    console.error(
      `Removed properties: ${finalResult.removedProperties.length}`
    );

    // Generate report
    const metadata: ReportMetadata = {
      stableRef: opts.stableRef,
      stableSha: stable.sha,
      currentRef: opts.currentRef,
      currentSha: current.sha,
      repoPath: opts.repoPath,
    };
    const report =
      opts.format === 'json'
        ? generateJsonReport(
            stable.version,
            current.version,
            finalResult,
            opts.mode,
            metadata
          )
        : generateReport(
            stable.version,
            current.version,
            finalResult,
            opts.mode,
            metadata
          );

    // Output report
    if (opts.output) {
      const dir = path.dirname(opts.output);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(opts.output, report);
      console.error(`\nReport written to ${opts.output}`);
    } else {
      process.stdout.write(report);
    }

    process.exit(breakingCount > 0 ? 1 : 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
