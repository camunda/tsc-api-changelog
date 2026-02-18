/**
 * Markdown report generation from compatibility check results.
 */

import { classifyRole } from './roles.js';
import type { CompatError, CompatResult } from './check.js';
import { summarizeError } from './summarize.js';

export type ReportMode = 'migration' | 'regression';

export interface ReportMetadata {
  stableRef: string;
  stableSha: string;
  currentRef: string;
  currentSha: string;
  repoPath: string;
}

// Known @hey-api/openapi-ts suffixes (longest first to avoid partial matches)
const OPERATION_SUFFIXES = [
  'Responses',
  'Response',
  'Errors',
  'Error',
  'Data',
];

/**
 * Extract operation name by stripping known suffixes.
 * Returns [operationName, suffix] or null if no suffix matches.
 */
function extractOperation(
  typeName: string
): [string, string] | null {
  for (const suffix of OPERATION_SUFFIXES) {
    if (
      typeName.endsWith(suffix) &&
      typeName.length > suffix.length
    ) {
      return [typeName.slice(0, -suffix.length), suffix];
    }
  }
  return null;
}

const SUFFIX_ROLE: Record<string, 'Request' | 'Response'> = {
  Data: 'Request',
  Response: 'Response',
  Responses: 'Response',
  Error: 'Response',
  Errors: 'Response',
};

type ChangeCategory = 'breaking' | 'exhaustiveness' | 'additive';

interface ChangeItem {
  text: string;
  isBreaking: boolean;
  annotation?: string;
  category: ChangeCategory;
  sourceType: string;
}

interface RoleGroup {
  typeNames: string[];
  items: ChangeItem[];
}

interface OperationGroup {
  name: string;
  request: RoleGroup;
  response: RoleGroup;
}

interface SchemaGroup {
  name: string;
  items: ChangeItem[];
}

function isBreakingError(err: CompatError): boolean {
  const summary = summarizeError(err);
  if (!summary) return true;
  return summary.category !== 'enum-member-added';
}

function annotationForError(err: CompatError): string | undefined {
  const summary = summarizeError(err);
  if (!summary) return undefined;
  if (summary.category === 'enum-member-added') return 'Exhaustiveness';
  if (summary.category === 'branded-type') return 'Type Safety';
  return undefined;
}

function categorize(isBreaking: boolean, annotation?: string): ChangeCategory {
  if (isBreaking) return 'breaking';
  if (annotation === 'Exhaustiveness') return 'exhaustiveness';
  return 'additive';
}

function formatError(err: CompatError): string {
  const summary = summarizeError(err);
  if (summary) return summary.text;
  if (err.details.length > 0) {
    return err.details.map((d) => d.trim()).join('; ');
  }
  const msg = err.message.replace(
    /^Type '.*?' is not assignable to type '.*?'\.\s*/,
    ''
  );
  return msg || err.message;
}

function buildChangedGroups(result: CompatResult): {
  operations: OperationGroup[];
  schemas: SchemaGroup[];
} {
  const opMap = new Map<string, OperationGroup>();
  const schemaMap = new Map<string, SchemaGroup>();

  function getOp(name: string): OperationGroup {
    if (!opMap.has(name)) {
      opMap.set(name, {
        name,
        request: { typeNames: [], items: [] },
        response: { typeNames: [], items: [] },
      });
    }
    return opMap.get(name)!;
  }

  function getSchema(name: string): SchemaGroup {
    if (!schemaMap.has(name)) {
      schemaMap.set(name, { name, items: [] });
    }
    return schemaMap.get(name)!;
  }

  function addItem(typeName: string, item: ChangeItem): void {
    const op = extractOperation(typeName);
    if (op) {
      const [opName, suffix] = op;
      const group = getOp(opName);
      const roleGroup =
        SUFFIX_ROLE[suffix] === 'Request'
          ? group.request
          : group.response;
      if (!roleGroup.typeNames.includes(typeName)) {
        roleGroup.typeNames.push(typeName);
      }
      roleGroup.items.push(item);
    } else {
      getSchema(typeName).items.push(item);
    }
  }

  for (const err of result.errors) {
    if (err.code === 'TS2724') continue;
    const breaking = isBreakingError(err);
    const annotation = annotationForError(err);
    addItem(err.typeName, {
      text: formatError(err),
      isBreaking: breaking,
      annotation,
      category: categorize(breaking, annotation),
      sourceType: err.typeName,
    });
  }

  for (const change of result.additiveChanges) {
    const typeStr = change.propertyType
      ? `: \`${change.propertyType}\``
      : '';
    addItem(change.typeName, {
      text: `Added property \`${change.property}\`${typeStr}`,
      isBreaking: false,
      category: 'additive',
      sourceType: change.typeName,
    });
  }

  for (const change of result.removedProperties) {
    const typeStr = change.propertyType
      ? `: \`${change.propertyType}\``
      : '';
    addItem(change.typeName, {
      text: `Removed property \`${change.property}\`${typeStr}`,
      isBreaking: true,
      category: 'breaking',
      sourceType: change.typeName,
    });
  }

  const operations = [...opMap.values()]
    .filter(
      (op) =>
        op.request.items.length > 0 ||
        op.response.items.length > 0
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const schemas = [...schemaMap.values()]
    .filter((s) => s.items.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { operations, schemas };
}

function groupNewTypes(
  addedTypes: string[]
): {
  newOperations: Map<string, string[]>;
  newSchemas: string[];
} {
  const newOperations = new Map<string, string[]>();
  const newSchemas: string[] = [];

  for (const name of addedTypes) {
    const op = extractOperation(name);
    if (op) {
      const arr = newOperations.get(op[0]) || [];
      arr.push(op[1]);
      newOperations.set(op[0], arr);
    } else {
      newSchemas.push(name);
    }
  }

  return { newOperations, newSchemas };
}

/**
 * Deduplicate items where a status-code-prefixed path (e.g. `.200.foo`)
 * duplicates a shorter path (e.g. `.foo`). The `Responses` wrapper type
 * nests the `Response` type under `.200`, producing identical change
 * descriptions with and without the status prefix. Keep the shorter one.
 */
function deduplicateItems(items: ChangeItem[]): ChangeItem[] {
  const seen = new Set<string>();
  const result: ChangeItem[] = [];

  // First pass: collect canonical (shorter) texts
  for (const item of items) {
    seen.add(item.text);
  }

  for (const item of items) {
    // Check if this item's text is a status-code-prefixed dup
    // Case 1: `.200.foo` duplicates `.foo`
    const prefixMatch = item.text.match(
      /^`\.(\d{3})\.(.*)`/
    );
    if (prefixMatch) {
      const withoutPrefix = item.text.replace(
        /^`\.\d{3}\./,
        '`.'
      );
      if (seen.has(withoutPrefix)) continue; // skip the dup
    }
    // Case 2: `.200`: description duplicates a bare description (no path)
    const bareStatusMatch = item.text.match(
      /^`\.(\d{3})`:\s*(.+)$/
    );
    if (bareStatusMatch) {
      const bareText = bareStatusMatch[2];
      if (seen.has(bareText)) continue; // skip the dup
    }
    result.push(item);
  }
  return result;
}

function renderItemInSection(
  item: ChangeItem,
  section: ChangeCategory
): string {
  let text = item.text;
  if (item.annotation) {
    // Suppress annotation that matches the section heading (redundant)
    const suppress =
      section === 'exhaustiveness' && item.annotation === 'Exhaustiveness';
    if (!suppress) {
      text += ` *(${item.annotation})*`;
    }
  }
  if (item.annotation === 'Type Safety') {
    text = `🛡️ ${text}`;
  }
  if (item.isBreaking) {
    text = `🔴 ${text} (breaking)`;
  }
  return text;
}

interface SectionEntry {
  sortKey: string;
  kind: 'operation' | 'schema';
  lines: string[];
}

function renderSeveritySection(
  lines: string[],
  heading: string,
  section: ChangeCategory,
  operations: OperationGroup[],
  schemas: SchemaGroup[],
  removedTypes: string[]
): void {
  const entries: SectionEntry[] = [];

  for (const op of operations) {
    const reqItems = deduplicateItems(
      op.request.items.filter((i) => i.category === section)
    );
    const resItems = deduplicateItems(
      op.response.items.filter((i) => i.category === section)
    );
    if (reqItems.length === 0 && resItems.length === 0) continue;

    const subLines: string[] = [];
    subLines.push(`### ${op.name}`);
    subLines.push('');
    if (reqItems.length > 0) {
      const typeNames = [
        ...new Set(reqItems.map((i) => i.sourceType)),
      ];
      const typeList = typeNames
        .map((t) => `\`${t}\``)
        .join(', ');
      subLines.push(`**Request** (${typeList})`);
      subLines.push('');
      for (const item of reqItems) {
        subLines.push(
          `- ${renderItemInSection(item, section)}`
        );
      }
      subLines.push('');
    }
    if (resItems.length > 0) {
      const typeNames = [
        ...new Set(resItems.map((i) => i.sourceType)),
      ];
      const typeList = typeNames
        .map((t) => `\`${t}\``)
        .join(', ');
      subLines.push(`**Response** (${typeList})`);
      subLines.push('');
      for (const item of resItems) {
        subLines.push(
          `- ${renderItemInSection(item, section)}`
        );
      }
      subLines.push('');
    }
    entries.push({ sortKey: op.name, kind: 'operation', lines: subLines });
  }

  for (const schema of schemas) {
    const items = deduplicateItems(
      schema.items.filter((i) => i.category === section)
    );
    if (items.length === 0) continue;

    const role = classifyRole(schema.name);
    const roleLabel =
      role === 'request'
        ? ' (request)'
        : role === 'response'
          ? ' (response)'
          : '';

    const subLines: string[] = [];
    subLines.push(`### \`${schema.name}\`${roleLabel}`);
    subLines.push('');
    for (const item of items) {
      subLines.push(
        `- ${renderItemInSection(item, section)}`
      );
    }
    subLines.push('');
    entries.push({ sortKey: schema.name, kind: 'schema', lines: subLines });
  }

  // Removed types appear in the breaking section
  for (const name of removedTypes.sort()) {
    entries.push({
      sortKey: name,
      kind: 'schema',
      lines: [`### \`${name}\``, '', '- 🔴 Type removed (breaking)', ''],
    });
  }

  if (entries.length === 0) return;

  // Operations first, then schemas, each alphabetically
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'operation' ? -1 : 1;
    return a.sortKey.localeCompare(b.sortKey);
  });

  lines.push(`## ${heading}`);
  lines.push('');
  for (const entry of entries) {
    lines.push(...entry.lines);
  }
}

export function countBreaking(result: CompatResult): number {
  const breakingTypes = new Set<string>(result.removedTypes);
  for (const err of result.errors) {
    if (err.code === 'TS2724') continue;
    if (isBreakingError(err)) breakingTypes.add(err.typeName);
  }
  for (const change of result.removedProperties) {
    breakingTypes.add(change.typeName);
  }
  return breakingTypes.size;
}

const REGRESSION_CATEGORIES = new Set([
  'enum-member-removed',
  'became-optional',
  'became-required',
  'null-removed',
  'widened-to-unknown',
  'type-changed',
]);

/**
 * Filter a CompatResult to only include regression-disallowed changes:
 * removed enum members, missing types, type widening, property type changes,
 * missing properties, optional→required request fields, required→optional response fields.
 */
export function filterForRegression(result: CompatResult): CompatResult {
  const filteredErrors = result.errors.filter((err) => {
    if (err.code === 'TS2724') return true; // removed type
    const summary = summarizeError(err);
    if (!summary) return true; // unknown = potentially disallowed
    return REGRESSION_CATEGORIES.has(summary.category);
  });

  const incompatibleTypes = [
    ...new Set(
      filteredErrors
        .filter((e) => e.code !== 'TS2724')
        .map((e) => e.typeName)
    ),
  ];

  return {
    errors: filteredErrors,
    stableCount: result.stableCount,
    currentCount: result.currentCount,
    addedTypes: [],
    removedTypes: result.removedTypes,
    incompatibleTypes,
    additiveChanges: [],
    removedProperties: result.removedProperties,
  };
}

export function generateReport(
  stableVersion: string,
  currentVersion: string,
  result: CompatResult,
  mode: ReportMode = 'migration',
  metadata?: ReportMetadata
): string {
  const lines: string[] = [];

  // Extract major.minor from stable version
  const stableMajorMinor = stableVersion.replace(/^(\d+\.\d+).*$/, '$1');

  if (mode === 'regression') {
    lines.push(
      `# API Regression Report: ${stableMajorMinor} → ${currentVersion}`
    );
  } else {
    lines.push(
      `# Migrating from ${stableMajorMinor} to ${currentVersion}`
    );
  }
  lines.push('');

  // Metadata in HTML comment
  const commentLines = [
    '<!--',
    `Generated by tsc-api-changelog — tsc --noEmit structural type checking`,
    `Generated at ${new Date().toISOString()}`,
    `Baseline: ${stableVersion}`,
    `Current:  ${currentVersion}`,
  ];
  if (metadata) {
    commentLines.push(`Repo:     ${metadata.repoPath}`);
    commentLines.push(`Stable:   ${metadata.stableRef} (${metadata.stableSha})`);
    commentLines.push(`Current:  ${metadata.currentRef} (${metadata.currentSha})`);
  }
  commentLines.push('-->');
  lines.push(commentLines.join('\n'));
  lines.push('');

  const { operations: changedOps, schemas: changedSchemas } =
    buildChangedGroups(result);
  const { newOperations, newSchemas } = groupNewTypes(
    result.addedTypes
  );
  const breakingCount = countBreaking(result);

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('|---|---|');
  lines.push(`| Types in baseline | ${result.stableCount} |`);
  lines.push(`| Types in current | ${result.currentCount} |`);
  lines.push(`| Removed types | ${result.removedTypes.length} |`);
  lines.push(
    `| Incompatible types | ${result.incompatibleTypes.length} |`
  );
  lines.push(`| New types | ${result.addedTypes.length} |`);
  lines.push(
    `| Additive property changes | ${result.additiveChanges.length} |`
  );
  lines.push(
    `| Removed properties | ${result.removedProperties.length} |`
  );
  lines.push(
    `| **Breaking changes** | **${breakingCount}** |`
  );
  lines.push('');
  lines.push(
    '> Enum member additions are not counted as breaking changes.'
  );
  lines.push('');

  // Legend
  lines.push('## Legend');
  lines.push('');
  lines.push(
    '| Annotation | Meaning |'
  );
  lines.push('|---|---|');
  lines.push(
    '| **(breaking change)** | Existing application code will not compile with this SDK version without modification. |'
  );
  lines.push(
    '| *(Exhaustiveness)* | An enum gained a new member. Existing code compiles, but `switch` statements without a `default` case may trigger exhaustiveness warnings. |'
  );
  lines.push(
    '| *(Type Safety)* | A primitive (`string`) was replaced with a branded type, providing enhanced type safety. Existing code that passes raw strings will need to use the branded constructor. |'
  );
  lines.push('');

  if (
    result.errors.length === 0 &&
    result.addedTypes.length === 0 &&
    result.additiveChanges.length === 0 &&
    result.removedProperties.length === 0
  ) {
    lines.push(
      'The public type API surface is fully compatible with the baseline.'
    );
    lines.push('');
    return lines.join('\n');
  }

  // Breaking Changes (includes removed types)
  renderSeveritySection(
    lines,
    'Breaking Changes',
    'breaking',
    changedOps,
    changedSchemas,
    result.removedTypes
  );

  // Exhaustiveness
  renderSeveritySection(
    lines,
    'Exhaustiveness',
    'exhaustiveness',
    changedOps,
    changedSchemas,
    []
  );

  // Additive Changes
  renderSeveritySection(
    lines,
    'Additive Changes',
    'additive',
    changedOps,
    changedSchemas,
    []
  );

  // New
  if (newOperations.size > 0 || newSchemas.length > 0) {
    lines.push('## New');
    lines.push('');

    interface NewEntry {
      sortKey: string;
      text: string;
    }
    const newEntries: NewEntry[] = [];

    for (const [opName, suffixes] of newOperations) {
      newEntries.push({
        sortKey: opName,
        text: `- **${opName}** — ${suffixes.sort().join(', ')}`,
      });
    }
    for (const name of newSchemas) {
      newEntries.push({
        sortKey: name,
        text: `- \`${name}\``,
      });
    }

    newEntries.sort((a, b) =>
      a.sortKey.localeCompare(b.sortKey)
    );
    for (const entry of newEntries) {
      lines.push(entry.text);
    }
    lines.push('');
  }

  // Acknowledgement
  lines.push('---');
  lines.push('');
  lines.push('## Acknowledgement');
  lines.push('');
  lines.push(
    'To acknowledge these changes on a `stable/**` branch, commit this file as-is.'
  );
  lines.push(
    'The CI gate will pass once this changeset file exists and matches the current API surface.'
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a JSON report with deterministic ordering for git-diffable output.
 * All object keys are alphabetically ordered and all arrays are sorted.
 */
export function generateJsonReport(
  stableVersion: string,
  currentVersion: string,
  result: CompatResult,
  mode: ReportMode = 'migration',
  metadata?: ReportMetadata
): string {
  const changes: Array<{
    category: string;
    changeType: string;
    description: string;
    operation: string | null;
    propertyPath: string | null;
    role: string;
    typeName: string;
  }> = [];

  // Process type errors
  for (const err of result.errors) {
    if (err.code === 'TS2724') continue; // handled via removedTypes
    const summary = summarizeError(err);
    const breaking = isBreakingError(err);
    const annotation = annotationForError(err);
    changes.push({
      category: categorize(breaking, annotation),
      changeType: summary?.category ?? 'unknown',
      description: formatError(err),
      operation: extractOperation(err.typeName)?.[0] ?? null,
      propertyPath: summary?.propertyPath ?? null,
      role: classifyRole(err.typeName),
      typeName: err.typeName,
    });
  }

  // Process additive changes
  for (const change of result.additiveChanges) {
    const typeStr = change.propertyType ? `: ${change.propertyType}` : '';
    changes.push({
      category: 'additive',
      changeType: 'added-property',
      description: `Added property ${change.property}${typeStr}`,
      operation: extractOperation(change.typeName)?.[0] ?? null,
      propertyPath: `.${change.property}`,
      role: classifyRole(change.typeName),
      typeName: change.typeName,
    });
  }

  // Process removed properties
  for (const change of result.removedProperties) {
    const typeStr = change.propertyType ? `: ${change.propertyType}` : '';
    changes.push({
      category: 'breaking',
      changeType: 'removed-property',
      description: `Removed property ${change.property}${typeStr}`,
      operation: extractOperation(change.typeName)?.[0] ?? null,
      propertyPath: `.${change.property}`,
      role: classifyRole(change.typeName),
      typeName: change.typeName,
    });
  }

  // Sort deterministically: category → typeName → description
  const categoryOrder: Record<string, number> = {
    breaking: 0,
    exhaustiveness: 1,
    additive: 2,
  };
  changes.sort((a, b) => {
    const ca = categoryOrder[a.category] ?? 99;
    const cb = categoryOrder[b.category] ?? 99;
    if (ca !== cb) return ca - cb;
    if (a.typeName !== b.typeName)
      return a.typeName.localeCompare(b.typeName);
    return a.description.localeCompare(b.description);
  });

  // Build report with alphabetically ordered keys for deterministic output
  const report = {
    changes,
    metadata: {
      currentRef: metadata?.currentRef ?? '',
      currentSha: metadata?.currentSha ?? '',
      currentVersion,
      mode,
      repoPath: metadata?.repoPath ?? '',
      stableRef: metadata?.stableRef ?? '',
      stableSha: metadata?.stableSha ?? '',
      stableVersion,
    },
    newTypes: [...result.addedTypes].sort(),
    removedTypes: [...result.removedTypes].sort(),
    summary: {
      addedTypeCount: result.addedTypes.length,
      additivePropertyChangeCount: result.additiveChanges.length,
      breakingChangeCount: countBreaking(result),
      currentTypeCount: result.currentCount,
      incompatibleTypeCount: result.incompatibleTypes.length,
      removedPropertyCount: result.removedProperties.length,
      removedTypeCount: result.removedTypes.length,
      stableTypeCount: result.stableCount,
    },
  };

  return JSON.stringify(report, null, 2) + '\n';
}
