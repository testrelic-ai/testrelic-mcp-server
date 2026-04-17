import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { CacheManager } from "../cache/index.js";
import type { ClientBundle } from "../clients/index.js";
import type { CodeNode } from "../types/index.js";
import { getLogger } from "../logger.js";

/**
 * Code map — an AST-extracted index of functions/classes in a target repo.
 *
 * v2 only has ONE real mode: local-disk walking (tree-sitter with regex
 * fallback). cloud-platform-app does not yet expose a remote code-map
 * endpoint, so `loadRemote` returns empty. Kept as an API hook for when
 * the platform starts pre-computing code maps.
 *
 * We push each node into the vector store so semantic queries work.
 */

export class CodeMap {
  private readonly ns = "code-map";
  private local = new Map<string, CodeNode[]>();

  constructor(
    private readonly clients: ClientBundle,
    private readonly cache: CacheManager,
  ) {}

  public async loadRemote(project_id: string): Promise<CodeNode[]> {
    const key = this.cache.key("code-map:remote", { project_id });
    const hit = this.cache.get<CodeNode[]>(key);
    if (hit) return hit.value;
    const { data } = await this.clients.testrelic.getCodeMap(project_id);
    this.cache.set(key, data, { ttlSeconds: 3_600, namespace: this.ns });
    await this.indexVectors(data);
    return data;
  }

  public async loadLocal(repoRoot: string, opts: { maxFiles?: number; extensions?: string[] } = {}): Promise<CodeNode[]> {
    if (this.local.has(repoRoot)) return this.local.get(repoRoot)!;
    const extensions = new Set(opts.extensions ?? [".ts", ".tsx", ".js", ".jsx"]);
    const nodes: CodeNode[] = [];
    const files: string[] = [];
    this.walk(repoRoot, extensions, files, opts.maxFiles ?? 2_500);

    const parser = await this.tryLoadTreeSitter();
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      const rel = relative(repoRoot, file);
      if (parser) {
        nodes.push(...extractWithTreeSitter(parser, rel, text));
      } else {
        nodes.push(...extractWithRegex(rel, text));
      }
    }
    this.local.set(repoRoot, nodes);
    await this.indexVectors(nodes);
    return nodes;
  }

  public async search(query: string, k = 8): Promise<Array<{ id: string; score: number; text: string; meta?: Record<string, unknown> }>> {
    return this.cache.vector.search(query, k);
  }

  private async indexVectors(nodes: CodeNode[]): Promise<void> {
    for (const n of nodes) {
      const text = `${n.kind} ${n.name} in ${n.file} (lines ${n.start_line}-${n.end_line}) ${(n.tags ?? []).join(" ")}`;
      await this.cache.vector.upsert({
        id: n.id,
        text,
        meta: { file: n.file, kind: n.kind, name: n.name, start_line: n.start_line, end_line: n.end_line },
      });
    }
  }

  private walk(dir: string, exts: Set<string>, out: string[], limit: number): void {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e === "node_modules" || e.startsWith(".") || e === "dist" || e === "build") continue;
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) this.walk(p, exts, out, limit);
      else if (exts.has(extname(e))) out.push(p);
    }
  }

  private async tryLoadTreeSitter(): Promise<null | { parse: (text: string) => unknown }> {
    try {
      // @ts-ignore optional native dep
      const tsMod = await import("tree-sitter").catch(() => null);
      // @ts-ignore optional native dep
      const langMod = await import("tree-sitter-typescript").catch(() => null);
      if (!tsMod || !langMod) return null;
      type ParserCtor = new () => { setLanguage: (l: unknown) => void; parse: (t: string) => unknown };
      const raw = tsMod as unknown as { default?: ParserCtor } & ParserCtor;
      const Parser: ParserCtor = raw.default ?? (raw as ParserCtor);
      const parser = new Parser();
      const tsLang = (langMod as { typescript?: unknown; default?: { typescript?: unknown } }).typescript ?? (langMod as { default?: { typescript?: unknown } }).default?.typescript;
      parser.setLanguage(tsLang);
      return parser;
    } catch (err) {
      getLogger().debug({ err }, "tree-sitter unavailable, using regex fallback");
      return null;
    }
  }
}

function extractWithTreeSitter(parser: { parse: (text: string) => unknown }, file: string, text: string): CodeNode[] {
  // Keep the AST walk minimal — we just want function/class nodes.
  try {
    const tree = parser.parse(text) as { rootNode: TreeNode };
    const nodes: CodeNode[] = [];
    walkAst(tree.rootNode, file, nodes);
    return nodes;
  } catch {
    return extractWithRegex(file, text);
  }
}

interface TreeNode {
  type: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildren: TreeNode[];
  childForFieldName(name: string): TreeNode | null;
  text: string;
}

function walkAst(node: TreeNode, file: string, out: CodeNode[]): void {
  const kindMap: Record<string, CodeNode["kind"]> = {
    function_declaration: "function",
    method_definition: "method",
    class_declaration: "class",
    arrow_function: "function",
    function: "function",
  };
  const kind = kindMap[node.type];
  if (kind) {
    const nameNode = node.childForFieldName("name");
    const name = nameNode?.text ?? "<anonymous>";
    out.push({
      id: `${file}:${name}:${node.startPosition.row + 1}`,
      file,
      name,
      kind,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
    });
  }
  for (const child of node.namedChildren ?? []) walkAst(child, file, out);
}

function extractWithRegex(file: string, text: string): CodeNode[] {
  const out: CodeNode[] = [];
  const lines = text.split(/\r?\n/);
  const patterns = [
    { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/g, kind: "function" as const },
    { re: /^\s*(?:export\s+)?class\s+(\w+)/g, kind: "class" as const },
    { re: /^\s*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/g, kind: "method" as const },
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const { re, kind } of patterns) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m && m[1]) {
        out.push({
          id: `${file}:${m[1]}:${i + 1}`,
          file,
          name: m[1],
          kind,
          start_line: i + 1,
          end_line: i + 1,
        });
      }
    }
  }
  return out;
}
