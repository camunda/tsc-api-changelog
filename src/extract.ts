/**
 * Extract exported type names from a TypeScript declaration file
 * using the TypeScript compiler API.
 */
import ts from 'typescript';

export function getExportedTypeNames(filePath: string): Set<string> {
  const program = ts.createProgram([filePath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    skipLibCheck: true,
  });

  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return new Set();

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return new Set();

  const exports = checker.getExportsOfModule(moduleSymbol);
  const names = new Set<string>();

  for (const exp of exports) {
    const resolved =
      exp.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exp)
        : exp;
    const decls = resolved.getDeclarations();
    if (!decls) continue;
    const decl = decls[0];
    if (
      ts.isTypeAliasDeclaration(decl) ||
      ts.isInterfaceDeclaration(decl)
    ) {
      names.add(exp.getName());
    }
  }

  return names;
}

/**
 * Look up the type of a property on an exported type.
 * Returns a concise type string (e.g. "string", "number[]", "RootProcessInstanceKey").
 * Returns undefined if the type or property is not found.
 */
export function getPropertyType(
  filePath: string,
  typeName: string,
  propertyName: string
): string | undefined {
  const program = ts.createProgram([filePath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    skipLibCheck: true,
  });

  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return undefined;

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return undefined;

  const exports = checker.getExportsOfModule(moduleSymbol);
  for (const exp of exports) {
    if (exp.getName() !== typeName) continue;
    const resolved =
      exp.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exp)
        : exp;
    const decls = resolved.getDeclarations();
    if (!decls || decls.length === 0) continue;

    const type = checker.getDeclaredTypeOfSymbol(resolved);
    const prop = type.getProperty(propertyName);
    if (!prop) continue;

    const propType = checker.getTypeOfSymbolAtLocation(
      prop,
      decls[0]
    );
    return checker.typeToString(
      propType,
      undefined,
      ts.TypeFormatFlags.NoTruncation
    );
  }
  return undefined;
}

/**
 * Batch lookup of property types for multiple (typeName, propertyName) pairs.
 * More efficient than calling getPropertyType repeatedly since it only
 * creates the program once.
 */
export function getPropertyTypes(
  filePath: string,
  queries: Array<{ typeName: string; propertyName: string }>
): Map<string, string> {
  const result = new Map<string, string>();
  if (queries.length === 0) return result;

  const program = ts.createProgram([filePath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    skipLibCheck: true,
  });

  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return result;

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return result;

  const exports = checker.getExportsOfModule(moduleSymbol);
  const exportMap = new Map<string, ts.Symbol>();
  for (const exp of exports) {
    exportMap.set(exp.getName(), exp);
  }

  for (const { typeName, propertyName } of queries) {
    const exp = exportMap.get(typeName);
    if (!exp) continue;

    const resolved =
      exp.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exp)
        : exp;
    const decls = resolved.getDeclarations();
    if (!decls || decls.length === 0) continue;

    const type = checker.getDeclaredTypeOfSymbol(resolved);
    const prop = type.getProperty(propertyName);
    if (!prop) continue;

    const propType = checker.getTypeOfSymbolAtLocation(
      prop,
      decls[0]
    );
    const typeStr = checker.typeToString(
      propType,
      undefined,
      ts.TypeFormatFlags.NoTruncation
    );
    const key = `${typeName}.${propertyName}`;
    result.set(key, typeStr);
  }

  return result;
}
