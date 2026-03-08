/**
 * Request/response role classification.
 *
 * Primary: structural inference from the types file — walks the type graph
 * from operation types whose role is known by convention (*Data → request,
 * *Response/*Responses/*Error/*Errors → response) and propagates to all
 * reachable schema types.
 *
 * Fallback: naming heuristics for types not reachable from any operation.
 *
 * - Request types: old input must be accepted by new API → Stable→Current
 * - Response types: new output must satisfy old consumer → Current→Stable
 * - Unknown: check both directions
 */
import ts from 'typescript';

export type TypeRole = 'request' | 'response' | 'unknown';

// ── Naming-heuristic fallback ──────────────────────────────────────────

const REQUEST_PATTERNS = [
  /Data$/,
  /Request$/,
  /Filter$/,
  /Query$/,
  /Instruction$/,
  /Input$/,
  /input$/,
];

const RESPONSE_PATTERNS = [
  /Response$/,
  /Responses$/,
  /Result$/,
  /Error$/,
  /Errors$/,
];

export function classifyRole(name: string): TypeRole {
  if (REQUEST_PATTERNS.some((p) => p.test(name))) return 'request';
  if (RESPONSE_PATTERNS.some((p) => p.test(name))) return 'response';
  return 'unknown';
}

// ── Structural role map ────────────────────────────────────────────────

export type RoleMap = Map<string, TypeRole>;

/** Operation-suffix conventions from @hey-api/openapi-ts */
const OPERATION_REQUEST_SUFFIXES = ['Data'];
const OPERATION_RESPONSE_SUFFIXES = ['Response', 'Responses', 'Error', 'Errors'];

/**
 * Build a role map by walking the type graph in a types file.
 *
 * 1. Identify operation types by suffix (fixed @hey-api conventions).
 * 2. For each operation type, walk all referenced type aliases/interfaces
 *    and propagate the role (request or response) to them.
 * 3. If a schema type is reachable from both request and response, mark
 *    it as 'unknown' (checked both directions).
 */
export function buildRoleMap(filePath: string): RoleMap {
  const program = ts.createProgram([filePath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    skipLibCheck: true,
  });

  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return new Map();

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return new Map();

  const exports = checker.getExportsOfModule(moduleSymbol);

  // Build a name → symbol lookup for all exported types
  const exportMap = new Map<string, ts.Symbol>();
  for (const exp of exports) {
    exportMap.set(exp.getName(), exp);
  }

  // Seed: classify operation types by suffix
  const seeds: Array<{ name: string; role: 'request' | 'response' }> = [];
  for (const name of exportMap.keys()) {
    if (OPERATION_REQUEST_SUFFIXES.some((s) => name.endsWith(s) && name.length > s.length)) {
      seeds.push({ name, role: 'request' });
    } else if (OPERATION_RESPONSE_SUFFIXES.some((s) => name.endsWith(s) && name.length > s.length)) {
      seeds.push({ name, role: 'response' });
    }
  }

  // Track which role(s) each type has been reached from
  const reachedFrom = new Map<string, Set<'request' | 'response'>>();

  function markRole(name: string, role: 'request' | 'response'): void {
    if (!reachedFrom.has(name)) {
      reachedFrom.set(name, new Set());
    }
    reachedFrom.get(name)!.add(role);
  }

  // Walk referenced types from a given type symbol
  function walkType(type: ts.Type, role: 'request' | 'response', visited: Set<number>): void {
    const typeId = (type as any).id as number | undefined;

    // Record exported names reachable from this role.
    // We always mark the name but only recurse into the declared-type
    // form of the alias when this is the first visit for this role
    // (the declared form preserves intersection/union structure that
    // property-type resolution flattens).
    const symbol = type.aliasSymbol ?? type.getSymbol();
    if (symbol) {
      const name = symbol.getName();
      if (exportMap.has(name)) {
        const firstVisitForRole = !reachedFrom.get(name)?.has(role);
        markRole(name, role);

        if (firstVisitForRole) {
          // Walk the declared type to see intersection/union/alias structure
          const expSym = exportMap.get(name)!;
          const resolvedSym = expSym.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(expSym)
            : expSym;
          const decls = resolvedSym.getDeclarations();
          if (decls && decls.length > 0) {
            const decl = decls[0];
            if (ts.isTypeAliasDeclaration(decl)) {
              const declaredType = checker.getTypeFromTypeNode(decl.type);
              if (declaredType !== type) {
                walkType(declaredType, role, visited);
              }
            }
          }
        }
      }
    }

    // Dedup by type identity for structural types
    if (typeId !== undefined && visited.has(typeId)) return;
    if (typeId !== undefined) visited.add(typeId);

    // Walk union/intersection members
    if (type.isUnion() || type.isIntersection()) {
      for (const member of type.types) {
        walkType(member, role, visited);
      }
    }

    // Walk properties
    for (const prop of type.getProperties()) {
      const propType = checker.getTypeOfSymbol(prop);
      walkType(propType, role, visited);
    }

    // Walk type arguments (generics)
    const typeArgs = (type as ts.TypeReference).typeArguments;
    if (typeArgs) {
      for (const arg of typeArgs) {
        walkType(arg, role, visited);
      }
    }

    // Walk index types (e.g. { [key: string]: FooItem })
    const stringIndex = type.getStringIndexType();
    if (stringIndex) walkType(stringIndex, role, visited);
    const numberIndex = type.getNumberIndexType();
    if (numberIndex) walkType(numberIndex, role, visited);
  }

  // Propagate from seeds
  for (const seed of seeds) {
    const sym = exportMap.get(seed.name);
    if (!sym) continue;
    const resolved = sym.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(sym)
      : sym;
    const decls = resolved.getDeclarations();
    if (!decls || decls.length === 0) continue;
    const type = checker.getDeclaredTypeOfSymbol(resolved);
    markRole(seed.name, seed.role);
    walkType(type, seed.role, new Set());
  }

  // Build final map
  const roleMap: RoleMap = new Map();
  for (const [name, roles] of reachedFrom) {
    if (roles.has('request') && roles.has('response')) {
      roleMap.set(name, 'unknown');
    } else if (roles.has('request')) {
      roleMap.set(name, 'request');
    } else {
      roleMap.set(name, 'response');
    }
  }

  return roleMap;
}

/**
 * Look up a type's role from a pre-built role map, falling back to
 * naming heuristics if the type wasn't reached from any operation.
 */
export function classifyRoleFromMap(name: string, roleMap: RoleMap): TypeRole {
  return roleMap.get(name) ?? classifyRole(name);
}
