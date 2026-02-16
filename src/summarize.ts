/**
 * Summarize tsc error detail chains into human-readable one-liners.
 *
 * Walks the detail lines bottom-up to find the root cause, extracts
 * the property path from intermediate lines, and produces a
 * structured summary. Returns null if no pattern matches (the
 * report renderer falls back to raw details in that case).
 */

import type { CompatError } from './check.js';

export interface ErrorSummary {
  /** One-line human-readable summary */
  text: string;
  /** The category of change */
  category:
    | 'enum-member-added'
    | 'enum-member-removed'
    | 'branded-type'
    | 'became-optional'
    | 'became-required'
    | 'null-removed'
    | 'widened-to-unknown'
    | 'type-changed';
  /** The root enum/type/brand involved */
  rootType?: string;
  /** The property path to the mismatch (e.g. ".body.tenantId") */
  propertyPath?: string;
}

/**
 * Extract the property path from intermediate detail lines.
 *
 * Recognises:
 *   "Types of property 'foo' are incompatible."
 *   "The types of 'path.to.prop' are incompatible between these types."
 */
function extractPropertyPath(details: string[]): string | undefined {
  const segments: string[] = [];

  for (const line of details) {
    // "Types of property 'foo' are incompatible."
    const propMatch = line.match(
      /Types of property '([^']+)' are incompatible/
    );
    if (propMatch) {
      segments.push(propMatch[1]);
      continue;
    }

    // "The types of 'body.tenantId' are incompatible between these types."
    const pathMatch = line.match(
      /The types of '([^']+)' are incompatible/
    );
    if (pathMatch) {
      // This already contains the dotted path
      segments.push(pathMatch[1]);
      continue;
    }
  }

  if (segments.length === 0) return undefined;
  return '.' + segments.join('.');
}

/**
 * Try to summarize a compat error into a one-liner.
 * Returns null if no known pattern matches.
 */
export function summarizeError(err: CompatError): ErrorSummary | null {
  if (err.details.length === 0) {
    // Try to match just the top-level message
    return matchLeafLine(err.message, err, undefined);
  }

  const propertyPath = extractPropertyPath(err.details);
  const lastLine = err.details[err.details.length - 1];

  return matchLeafLine(lastLine, err, propertyPath);
}

function matchLeafLine(
  line: string,
  err: CompatError,
  propertyPath: string | undefined
): ErrorSummary | null {
  const pathPrefix = propertyPath ? `\`${propertyPath}\`: ` : '';

  // ── Branded type: Type 'string' is not assignable to type '{ readonly __brand: "TenantId"; }'
  const brandMatch = line.match(
    /Type 'string' is not assignable to type '\{ readonly __brand: "([^"]+)"/
  );
  if (brandMatch) {
    const brand = brandMatch[1];
    return {
      text: `${pathPrefix}\`string\` → branded \`${brand}\``,
      category: 'branded-type',
      rootType: brand,
      propertyPath,
    };
  }

  // ── Enum member: Type '"VALUE"' is not assignable to type 'EnumType | ...'
  const enumMatch = line.match(
    /Type '"([^"]+)"' is not assignable to type '([^']+)'/
  );
  if (enumMatch) {
    const [, value, targetType] = enumMatch;
    // Strip " | undefined" from target
    const enumName = targetType.replace(/ \| undefined$/, '');
    const isAdded =
      err.direction === 'response' ||
      err.direction === 'reverse';
    if (isAdded) {
      return {
        text: `${pathPrefix}\`${enumName}\` gained member \`"${value}"\``,
        category: 'enum-member-added',
        rootType: enumName,
        propertyPath,
      };
    } else {
      return {
        text: `${pathPrefix}\`${enumName}\` lost member \`"${value}"\``,
        category: 'enum-member-removed',
        rootType: enumName,
        propertyPath,
      };
    }
  }

  // ── Null removed: Type 'null' is not assignable to type '...'
  const nullMatch = line.match(
    /Type 'null' is not assignable to type '([^']+)'/
  );
  if (nullMatch) {
    return {
      text: `${pathPrefix}\`null\` removed from union`,
      category: 'null-removed',
      propertyPath,
    };
  }

  // ── Property became optional: Type 'undefined' is not assignable to type '...'
  const undefMatch = line.match(
    /Type 'undefined' is not assignable to type '([^']+)'/
  );
  if (undefMatch) {
    const targetType = undefMatch[1];
    const isResponse =
      err.direction === 'response' ||
      err.direction === 'reverse';
    if (isResponse) {
      return {
        text: `${pathPrefix}became optional (was required \`${targetType}\`)`,
        category: 'became-optional',
        rootType: targetType,
        propertyPath,
      };
    } else {
      return {
        text: `${pathPrefix}became required (\`${targetType}\`)`,
        category: 'became-required',
        rootType: targetType,
        propertyPath,
      };
    }
  }

  // ── Widened to unknown: Type 'unknown' is not assignable to type '...'
  const unknownMatch = line.match(
    /Type 'unknown' is not assignable to type '([^']+)'/
  );
  if (unknownMatch) {
    return {
      text: `${pathPrefix}type widened from \`${unknownMatch[1]}\` to \`unknown\``,
      category: 'widened-to-unknown',
      rootType: unknownMatch[1],
      propertyPath,
    };
  }

  // ── General type change: Type 'X' is not assignable to type 'Y'
  const generalMatch = line.match(
    /Type '([^']+)' is not assignable to type '([^']+)'/
  );
  if (generalMatch) {
    const [, fromType, toType] = generalMatch;
    // Skip deeply nested structural expansions (too noisy)
    if (fromType.length > 80 || toType.length > 80) {
      return null;
    }
    const isResponse =
      err.direction === 'response' ||
      err.direction === 'reverse';
    // For responses: Current is not assignable to Stable
    // means the API changed from toType to fromType
    const [oldT, newT] = isResponse
      ? [toType, fromType]
      : [fromType, toType];
    return {
      text: `${pathPrefix}type changed from \`${oldT}\` to \`${newT}\``,
      category: 'type-changed',
      rootType: toType,
      propertyPath,
    };
  }

  return null;
}
