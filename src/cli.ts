#!/usr/bin/env node
/**
 * CLI entry point for the type comparator.
 *
 * Usage:
 *   tsc-api-changelog <repo-path> <stable-ref> <current-ref> [--types-file <path>] [--out-dir <path>]
 *
 * Examples:
 *   tsc-api-changelog ./orchestration-cluster-api-js v8.8.4 main
 *   tsc-api-changelog /abs/path/to/repo stable/8.8 main --types-file src/gen/types.gen.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveTypesFromRef } from './resolve.js';
import { getExportedTypeNames } from './extract.js';
import { runCompatCheck } from './check.js';
import { countBreaking, generateReport } from './report.js';
import type { ReportMetadata } from './report.js';

interface CliOptions {
  repoPath: string;
  stableRef: string;
  currentRef: string;
  typesFile: string;
  outDir: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2); // strip node + script
  const positional: string[] = [];
  let typesFile = 'src/gen/types.gen.ts';
  let outDir: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--types-file' && i + 1 < args.length) {
      typesFile = args[++i];
    } else if (args[i] === '--out-dir' && i + 1 < args.length) {
      outDir = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      printUsage();
      process.exit(0);
    } else if (!args[i].startsWith('--')) {
      positional.push(args[i]);
    } else {
      console.error(`Unknown option: ${args[i]}`);
      printUsage();
      process.exit(1);
    }
  }

  if (positional.length < 3) {
    console.error(
      'Error: requires <repo-path> <stable-ref> <current-ref>'
    );
    printUsage();
    process.exit(1);
  }

  return {
    repoPath: path.resolve(positional[0]),
    stableRef: positional[1],
    currentRef: positional[2],
    typesFile,
    outDir,
  };
}

function printUsage(): void {
  console.log(`
Usage: tsc-api-changelog <repo-path> <stable-ref> <current-ref> [options]

Arguments:
  repo-path     Path to the git repository
  stable-ref    Git ref for the stable/baseline version (tag, branch, SHA)
  current-ref   Git ref for the current/next version (tag, branch, SHA)

Options:
  --types-file <path>  Path to the types file within the repo
                       (default: src/gen/types.gen.ts)
  --out-dir <path>     Directory for the output report
                       (default: <repo-path>/changes)
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
    console.log(`Repository: ${opts.repoPath}`);
    console.log(`Stable ref: ${opts.stableRef}`);
    console.log(`Current ref: ${opts.currentRef}`);
    console.log(`Types file: ${opts.typesFile}`);
    console.log('');

    const stable = resolveTypesFromRef(
      opts.repoPath,
      opts.stableRef,
      tmpDir,
      opts.typesFile
    );
    console.log(
      `Stable: ${stable.version} (${stable.sha.slice(0, 8)})`
    );

    const current = resolveTypesFromRef(
      opts.repoPath,
      opts.currentRef,
      tmpDir,
      opts.typesFile
    );
    console.log(
      `Current: ${current.version} (${current.sha.slice(0, 8)})`
    );

    // Extract type names
    const stableNames = getExportedTypeNames(stable.path);
    const currentNames = getExportedTypeNames(current.path);
    console.log(
      `Types: ${stableNames.size} stable, ${currentNames.size} current`
    );
    console.log('');

    // Run compatibility check
    console.log('Running tsc compatibility check...');
    const result = runCompatCheck(
      stable.path,
      current.path,
      tmpDir,
      stableNames,
      currentNames
    );

    const breakingCount = countBreaking(result);
    console.log(
      `Found ${breakingCount} breaking changes`
    );
    console.log(`New types: ${result.addedTypes.length}`);
    console.log(
      `Additive property changes: ${result.additiveChanges.length}`
    );
    console.log(
      `Removed properties: ${result.removedProperties.length}`
    );

    // Generate report
    const metadata: ReportMetadata = {
      stableRef: opts.stableRef,
      stableSha: stable.sha,
      currentRef: opts.currentRef,
      currentSha: current.sha,
      repoPath: opts.repoPath,
    };
    const report = generateReport(
      stable.version,
      current.version,
      result,
      metadata
    );

    // Write report
    const outDir =
      opts.outDir || path.join(opts.repoPath, 'changes');
    fs.mkdirSync(outDir, { recursive: true });
    const filename = `${stable.version}->${current.version}.md`;
    const reportPath = path.join(outDir, filename);
    fs.writeFileSync(reportPath, report);
    console.log(`\nReport written to ${reportPath}`);

    // Also print to stdout if there are breaking changes
    if (breakingCount > 0) {
      console.log('\n' + '='.repeat(60));
      console.log(report);
    }

    process.exit(breakingCount > 0 ? 1 : 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
