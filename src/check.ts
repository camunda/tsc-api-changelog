/**
 * Generate the tsc compatibility check file and run it.
 *
 * For each exported type in the baseline (stable) file, generates a
 * value-level assignment:
 *
 *   const _check: Current.Foo = {} as any as Stable.Foo;
 *
 * TypeScript's structural type system then checks compatibility:
 *   - Removed types → TS2724 "has no exported member"
 *   - Assignability breaks → TS2322 "Type is not assignable"
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { classifyRole } from './roles.js';
import { getPropertyTypes } from './extract.js';

export interface CompatError {
  typeName: string;
  direction: 'request' | 'response' | 'forward' | 'reverse';
  code: string;
  message: string;
  /** Continuation lines from tsc showing the structural mismatch detail */
  details: string[];
}

export interface AdditiveChange {
  typeName: string;
  property: string;
  propertyType?: string;
  message: string;
  details: string[];
}

export interface CompatResult {
  errors: CompatError[];
  stableCount: number;
  currentCount: number;
  addedTypes: string[];
  removedTypes: string[];
  incompatibleTypes: string[];
  additiveChanges: AdditiveChange[];
  removedProperties: AdditiveChange[];
}

/**
 * Generate the compat-check.ts file content.
 */
export function generateCompatCheckSource(
  baselineNames: Set<string>,
  stableFileName: string,
  currentFileName: string
): string {
  const lines: string[] = [];
  lines.push('// Auto-generated API compatibility check');
  lines.push(
    '// Type errors here = breaking changes in the public API.'
  );
  lines.push('');
  lines.push(
    `import type * as Stable from "./${stableFileName.replace(/\.ts$/, '.js')}";`
  );
  lines.push(
    `import type * as Current from "./${currentFileName.replace(/\.ts$/, '.js')}";`
  );
  lines.push('');

  for (const name of [...baselineNames].sort()) {
    const role = classifyRole(name);
    const safeId = name.replace(/[^a-zA-Z0-9_]/g, '_');

    if (role === 'request') {
      lines.push(
        `const _req_${safeId}: Current.${name} = {} as any as Stable.${name};`
      );
    } else if (role === 'response') {
      lines.push(
        `const _res_${safeId}: Stable.${name} = {} as any as Current.${name};`
      );
    } else {
      lines.push(
        `const _fwd_${safeId}: Current.${name} = {} as any as Stable.${name};`
      );
      lines.push(
        `const _rev_${safeId}: Stable.${name} = {} as any as Current.${name};`
      );
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate a second-pass check file that uses Required<T> to detect
 * additive property changes that are invisible to normal assignability.
 *
 * For types present in both versions, generates:
 *   const _added_Foo: Required<Current.Foo> = {} as any as Required<Stable.Foo>;
 *
 * If Current.Foo gained a property, Required forces it to be present,
 * and tsc reports the missing property by name.
 */
export function generateAdditiveCheckSource(
  commonNames: Set<string>,
  stableFileName: string,
  currentFileName: string
): string {
  const lines: string[] = [];
  lines.push('// Auto-generated additive property detection');
  lines.push(
    '// Errors here = new properties added (non-breaking, informational).'
  );
  lines.push('');
  lines.push(
    `import type * as Stable from "./${stableFileName.replace(/\.ts$/, '.js')}";`
  );
  lines.push(
    `import type * as Current from "./${currentFileName.replace(/\.ts$/, '.js')}";`
  );
  lines.push('');
  lines.push(
    '// DeepRequired recursively makes all properties required'
  );
  lines.push(
    'type DeepRequired<T> = T extends object ? { [K in keyof T]-?: DeepRequired<T[K]> } : T;'
  );
  lines.push('');

  for (const name of [...commonNames].sort()) {
    const safeId = name.replace(/[^a-zA-Z0-9_]/g, '_');
    lines.push(
      `const _added_${safeId}: DeepRequired<Current.${name}> = {} as any as DeepRequired<Stable.${name}>;`
    );
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate a third-pass check file that detects removed properties.
 *
 * Reverse of the additive check:
 *   const _removed_Foo: DeepRequired<Stable.Foo> = {} as any as DeepRequired<Current.Foo>;
 *
 * If Stable.Foo had a property that Current.Foo no longer has,
 * tsc reports the missing property by name.
 */
export function generateRemovedCheckSource(
  commonNames: Set<string>,
  stableFileName: string,
  currentFileName: string
): string {
  const lines: string[] = [];
  lines.push('// Auto-generated removed property detection');
  lines.push(
    '// Errors here = properties removed (informational).'
  );
  lines.push('');
  lines.push(
    `import type * as Stable from "./${stableFileName.replace(/\.ts$/, '.js')}";`
  );
  lines.push(
    `import type * as Current from "./${currentFileName.replace(/\.ts$/, '.js')}";`
  );
  lines.push('');
  lines.push(
    'type DeepRequired<T> = T extends object ? { [K in keyof T]-?: DeepRequired<T[K]> } : T;'
  );
  lines.push('');

  for (const name of [...commonNames].sort()) {
    const safeId = name.replace(/[^a-zA-Z0-9_]/g, '_');
    lines.push(
      `const _removed_${safeId}: DeepRequired<Stable.${name}> = {} as any as DeepRequired<Current.${name}>;`
    );
  }

  return lines.join('\n') + '\n';
}

/**
 * Run tsc --noEmit in a directory and return raw output.
 */
function runTsc(dir: string, checkFile = 'compat-check.ts'): string {
  // Write tsconfig
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ES2022',
      moduleResolution: 'node',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: [checkFile],
  };

  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2)
  );

  try {
    execSync('npx -p typescript tsc --noEmit', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return '';
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return (err.stdout || '') + (err.stderr || '');
  }
}

/**
 * Strip import("...").TypeName paths down to just the type name.
 * e.g. import("/tmp/foo/stable").AuthorizationResult → AuthorizationResult
 */
function cleanImportPaths(text: string): string {
  return text.replace(
    /import\(['"][^'"]+['"]\)\./g,
    ''
  );
}

/**
 * Parse tsc output into structured errors, capturing continuation
 * lines that show the structural mismatch detail.
 *
 * tsc output format:
 *   check.ts(3,7): error TS2322: Type '...' is not assignable to type '...'.
 *     Types of property 'foo' are incompatible.
 *       Type 'string' is not assignable to type 'number'.
 */
function parseTscOutput(
  output: string,
  compatCheckPath: string
): CompatError[] {
  const errors: CompatError[] = [];
  const lines = output.split('\n');
  const compatLines = fs
    .readFileSync(compatCheckPath, 'utf-8')
    .split('\n');

  // Match: compat-check.ts(42,7): error TS2322: Type ...
  const errorPattern = /^[^(]+\((\d+),\d+\): error (TS\d+): (.+)/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(errorPattern);
    if (!match) continue;

    const [, lineNumStr, code, rawMessage] = match;
    const lineNum = parseInt(lineNumStr, 10);
    const sourceLine = compatLines[lineNum - 1] || '';

    const varMatch = sourceLine.match(
      /const _(\w+?)_([A-Za-z_]\w*)/
    );
    if (!varMatch) continue;

    const [, prefix, typeName] = varMatch;

    let direction: CompatError['direction'];
    if (prefix === 'req') direction = 'request';
    else if (prefix === 'res') direction = 'response';
    else if (prefix === 'fwd') direction = 'forward';
    else direction = 'reverse';

    // Collect continuation lines (indented lines following the error)
    const details: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      // Continuation lines start with whitespace and don't match the error pattern
      if (next.match(/^\s{2,}/) && !next.match(errorPattern)) {
        details.push(cleanImportPaths(next.trimStart()));
        j++;
      } else {
        break;
      }
    }

    const message = cleanImportPaths(rawMessage);
    errors.push({ typeName, direction, code, message, details });
  }

  return errors;
}

/**
 * Parse additive-check tsc output into structured changes.
 *
 * Looks for TS2741 "Property 'X' is missing in type ..." errors
 * from the _added_ prefixed assignments.
 */
function parseAdditiveOutput(
  output: string,
  checkPath: string
): AdditiveChange[] {
  const changes: AdditiveChange[] = [];
  const lines = output.split('\n');
  const checkLines = fs
    .readFileSync(checkPath, 'utf-8')
    .split('\n');

  const errorPattern = /^[^(]+\((\d+),\d+\): error (TS\d+): (.+)/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(errorPattern);
    if (!match) continue;

    const [, lineNumStr, code, rawMessage] = match;

    // Only keep TS2741 (single missing property) and TS2739 (multiple).
    // Skip TS2322 (type incompatibility) — those are breaking changes
    // that the first pass already captures, not additive additions.
    if (code !== 'TS2741' && code !== 'TS2739') continue;

    const lineNum = parseInt(lineNumStr, 10);
    const sourceLine = checkLines[lineNum - 1] || '';

    const varMatch = sourceLine.match(
      /const _(?:added|removed)_([A-Za-z_]\w*)/
    );
    if (!varMatch) continue;

    const typeName = varMatch[1];
    const message = cleanImportPaths(rawMessage);

    // Collect continuation lines
    const details: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (next.match(/^\s{2,}/) && !next.match(errorPattern)) {
        details.push(cleanImportPaths(next.trimStart()));
        j++;
      } else {
        break;
      }
    }

    // Extract property name(s) from the message and detail lines.
    // TS2741: "Property 'X' is missing in type ..."
    // TS2739: "Type '...' is missing the following properties from type '...': y, z"
    const allLines = [message, ...details];
    const foundProps: string[] = [];

    for (const line of allLines) {
      const singleMatch = line.match(
        /Property '([^']+)' is missing in type/
      );
      if (singleMatch) {
        foundProps.push(singleMatch[1]);
        continue;
      }
      const multiMatch = line.match(
        /is missing the following properties from type '[^']+': (.+)/
      );
      if (multiMatch) {
        for (const p of multiMatch[1].split(',').map((s) => s.trim())) {
          foundProps.push(p);
        }
      }
    }

    if (foundProps.length > 0) {
      for (const prop of foundProps) {
        changes.push({ typeName, property: prop, message, details });
      }
    } else {
      changes.push({ typeName, property: '(unknown)', message, details });
    }
  }

  return changes;
}

/**
 * Run the full compatibility check.
 *
 * @param stablePath - Path to the stable (old) types file
 * @param currentPath - Path to the current (new) types file
 * @param workDir - Temp directory to use for generated files
 * @param stableNames - Pre-extracted stable type names
 * @param currentNames - Pre-extracted current type names
 */
export function runCompatCheck(
  stablePath: string,
  currentPath: string,
  workDir: string,
  stableNames: Set<string>,
  currentNames: Set<string>
): CompatResult {
  const stableFile = path.basename(stablePath);
  const currentFile = path.basename(currentPath);

  // Generate the check file
  const checkSource = generateCompatCheckSource(
    stableNames,
    stableFile,
    currentFile
  );

  const checkPath = path.join(workDir, 'compat-check.ts');
  fs.writeFileSync(checkPath, checkSource);

  // Copy type files into workDir if not already there
  const destStable = path.join(workDir, stableFile);
  const destCurrent = path.join(workDir, currentFile);
  if (path.resolve(stablePath) !== path.resolve(destStable)) {
    fs.copyFileSync(stablePath, destStable);
  }
  if (path.resolve(currentPath) !== path.resolve(destCurrent)) {
    fs.copyFileSync(currentPath, destCurrent);
  }

  // Run tsc — breaking changes pass
  const tscOutput = runTsc(workDir);
  const errors = parseTscOutput(tscOutput, checkPath);

  // Categorize breaking changes
  const addedTypes = [...currentNames].filter(
    (n) => !stableNames.has(n)
  );

  const removedTypes: string[] = [];
  const incompatibleTypes: string[] = [];

  const byType = new Map<string, CompatError[]>();
  for (const err of errors) {
    const arr = byType.get(err.typeName) || [];
    arr.push(err);
    byType.set(err.typeName, arr);
  }

  for (const [typeName, typeErrors] of byType) {
    if (typeErrors.some((e) => e.code === 'TS2724')) {
      removedTypes.push(typeName);
    } else {
      incompatibleTypes.push(typeName);
    }
  }

  // Second pass — additive property detection via DeepRequired<T>
  const commonNames = new Set(
    [...stableNames].filter((n) => currentNames.has(n))
  );

  const additiveCheckSource = generateAdditiveCheckSource(
    commonNames,
    stableFile,
    currentFile
  );

  const additiveCheckPath = path.join(
    workDir,
    'additive-check.ts'
  );
  fs.writeFileSync(additiveCheckPath, additiveCheckSource);

  const additiveOutput = runTsc(workDir, 'additive-check.ts');
  const rawAdditiveChanges = parseAdditiveOutput(
    additiveOutput,
    additiveCheckPath
  );

  // Filter out types already flagged as incompatible (those are
  // breaking, not additive) and removed types
  const breakingSet = new Set([
    ...incompatibleTypes,
    ...removedTypes,
  ]);
  const additiveChanges = rawAdditiveChanges.filter(
    (c) => !breakingSet.has(c.typeName)
  );

  // Resolve property types for additive changes
  const additiveQueries = additiveChanges
    .filter((c) => c.property !== '(unknown)')
    .map((c) => ({ typeName: c.typeName, propertyName: c.property }));
  const additivePropertyTypes = getPropertyTypes(
    currentPath,
    additiveQueries
  );
  for (const c of additiveChanges) {
    const key = `${c.typeName}.${c.property}`;
    c.propertyType = additivePropertyTypes.get(key);
  }

  // Third pass — removed property detection (reverse DeepRequired)
  const removedCheckSource = generateRemovedCheckSource(
    commonNames,
    stableFile,
    currentFile
  );

  const removedCheckPath = path.join(
    workDir,
    'removed-check.ts'
  );
  fs.writeFileSync(removedCheckPath, removedCheckSource);

  const removedOutput = runTsc(workDir, 'removed-check.ts');
  const rawRemovedProperties = parseAdditiveOutput(
    removedOutput,
    removedCheckPath
  );

  // Filter out types already flagged as breaking
  const removedProperties = rawRemovedProperties.filter(
    (c) => !breakingSet.has(c.typeName)
  );

  // Resolve property types for removed properties (from stable file)
  const removedQueries = removedProperties
    .filter((c) => c.property !== '(unknown)')
    .map((c) => ({ typeName: c.typeName, propertyName: c.property }));
  const removedPropertyTypes = getPropertyTypes(
    stablePath,
    removedQueries
  );
  for (const c of removedProperties) {
    const key = `${c.typeName}.${c.property}`;
    c.propertyType = removedPropertyTypes.get(key);
  }

  return {
    errors,
    stableCount: stableNames.size,
    currentCount: currentNames.size,
    addedTypes,
    removedTypes,
    incompatibleTypes,
    additiveChanges,
    removedProperties,
  };
}
