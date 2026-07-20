import { isAbsolute, relative, resolve } from "node:path";
import { InvalidInputError } from "../errors.js";

/**
 * Resolve `candidate` against `baseDir` and guarantee the result stays inside
 * `baseDir`. Blocks path traversal (`../`), absolute paths pointing outside the
 * sandbox, and (on Windows) cross-drive references. Anything that escapes — or
 * resolves to the directory itself — is rejected.
 *
 * Any tool that turns caller-supplied text into a filesystem path MUST route it
 * through here. The creation tools shell out to `tsc` on the resolved path and
 * the artifacts tool writes a file to it; without containment either is an
 * arbitrary-file primitive as the server-process user — a real hazard on the
 * hosted HTTP transport where the caller is remote.
 */
export function resolveWithinDir(baseDir: string, candidate: string): string {
  const base = resolve(baseDir);
  const resolved = resolve(base, candidate);
  const rel = relative(base, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new InvalidInputError(
      `Path "${candidate}" escapes the allowed directory (${base}).`,
      "PATH_TRAVERSAL",
    );
  }
  return resolved;
}
