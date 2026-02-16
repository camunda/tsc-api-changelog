/**
 * Resolve a types file from a git ref in a repository.
 *
 * Given a repo path and a git ref (tag, branch, commit), extracts
 * src/gen/types.gen.ts from that ref without a full checkout.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ResolvedTypes {
  /** Absolute path to the extracted types file (temp) */
  path: string;
  /** The git ref that was resolved */
  ref: string;
  /** The resolved commit SHA */
  sha: string;
  /** The SDK version from package.json at that ref */
  version: string;
}

/**
 * Extract the types file and version from a git ref.
 *
 * @param repoPath - Absolute path to a git repository
 * @param ref - Git ref (tag, branch, SHA)
 * @param typesFile - Path to the types file within the repo (default: src/gen/types.gen.ts)
 * @param outDir - Directory to write the extracted file into
 */
export function resolveTypesFromRef(
  repoPath: string,
  ref: string,
  outDir: string,
  typesFile = 'src/gen/types.gen.ts'
): ResolvedTypes {
  // Resolve the ref to a SHA
  const sha = execSync(`git rev-parse "${ref}"`, {
    cwd: repoPath,
    encoding: 'utf-8',
  }).trim();

  // Extract the types file content
  let content: string;
  try {
    content = execSync(`git show "${ref}:${typesFile}"`, {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB
    });
  } catch {
    throw new Error(
      `Cannot read ${typesFile} from ref "${ref}" in ${repoPath}.\n` +
        `Make sure the ref exists and the types file is committed at that ref.`
    );
  }

  // Extract version from package.json at that ref
  let version = ref;
  try {
    const pkgJson = execSync(`git show "${ref}:package.json"`, {
      cwd: repoPath,
      encoding: 'utf-8',
    });
    const pkg = JSON.parse(pkgJson);
    version = pkg.version || ref;
  } catch {
    // Non-fatal — use the ref name as-is
  }

  // Write to temp file
  const safeName = ref.replace(/[^a-zA-Z0-9._-]/g, '_');
  const outPath = path.join(outDir, `types-${safeName}.ts`);
  fs.writeFileSync(outPath, content);

  return { path: outPath, ref, sha, version };
}
