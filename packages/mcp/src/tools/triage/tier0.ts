// Ostra Tier 0 S1 — offline-trained, no-network failure classification.
// Dependency-free tree-ensemble evaluation, ported byte-for-byte (same
// vocab, same tree-walk) from the Ostra Tier 0 PoC's runtime-js/
// ostra-tier0.mjs, which is itself parity-tested against the Python
// reference. No outbound call of any kind — the model is the embedded
// TIER0_S1_MODEL constant (tier0-model.ts), not fetched or read from disk.
//
// Scope: PoC synthetic training data (see the ostra-tier0 repo's
// QUESTIONS.md) — this is a real classifier, not a toy, but it has not been
// retrained on real TestRelic run data yet.

export interface Tier0TreeNode {
  nodeid: number;
  /** Present in XGBoost's raw dump on every non-leaf node; unused by
   * evaluation (the tree walk follows yes/no/missing, not depth). */
  depth?: number;
  leaf?: number;
  split?: string;
  split_condition?: number;
  yes?: number;
  no?: number;
  missing?: number;
  children?: Tier0TreeNode[];
}

export interface Tier0Model {
  format: string;
  task: string;
  classes: string[];
  feature_names: string[];
  num_class: number;
  base_score: number[];
  trees: Tier0TreeNode[];
  decision: { defer_threshold: number };
  /** Training provenance (gate metrics, row counts) — informational only,
   * unused by evaluation. */
  metadata?: Record<string, unknown>;
}

export type Tier0TriageClass = "flaky" | "product_bug" | "test_bug" | "environment" | "selector_drift";

const ERROR_CLASSES = [
  "timeout",
  "locator_not_found",
  "stale_element",
  "strict_mode_violation",
  "assertion_mismatch",
  "network_error",
  "script_error",
  "unmapped",
] as const;
const FRAMEWORKS = ["playwright", "cypress", "jest", "selenium"] as const;
const CAPTURE_LEVELS = ["full", "partial", "none"] as const;
const NUMERIC_FEATURES = [
  "error_class_code",
  "action_code",
  "locator_strategy_code",
  "framework_code",
  "capture_level_code",
  "diff_files_changed",
  "diff_lines_added",
  "diff_lines_removed",
  "diff_touches_test_file",
  "diff_touches_selector_file",
  "diff_locator_values_removed",
  "dom_locator_found",
  "memory_runs_50",
  "memory_flake_rate_50",
  "memory_failed_count_50",
  "memory_signature_repeat_count",
] as const;

function codeOf(value: string | undefined, vocab: readonly string[]): number {
  if (value === undefined) return NaN;
  const i = vocab.indexOf(value);
  return i === -1 ? NaN : i;
}
function numOrNaN(v: number | undefined | null): number {
  return v === undefined || v === null ? NaN : v;
}

/** Same classifier as `cloud-platform-app`'s `tier0Client.ts` and
 * `trc-tier0-capture`'s `error_class.rs` — kept in sync by hand across all
 * three languages; see AUG-11/AUG-13 for the sibling ports. */
export function classifyTier0ErrorClass(errorMessage: string): (typeof ERROR_CLASSES)[number] {
  const m = (errorMessage || "").toLowerCase();
  if (/detached from dom|stale element/.test(m)) return "stale_element";
  if (/strict mode violation|multiple elements/.test(m)) return "strict_mode_violation";
  if (/timeout|timed out|waiting for/.test(m)) return "timeout";
  if (/element not found|no element|locator.*not found/.test(m)) return "locator_not_found";
  if (/expected.*to (be|equal|have|contain|match)|assertionerror|but (got|received|was)/.test(m)) return "assertion_mismatch";
  if (/net::err_|fetch failed|network error|cors|cross-origin|5\d\d/.test(m)) return "network_error";
  if (/typeerror|referenceerror|syntaxerror|undefined is not|cannot read property/.test(m)) return "script_error";
  return "unmapped";
}

/** Evidence this tool can pull from the platform's own clients
 * (`getRunFailures` + `queryFlakinessScores`) — the diff/DOM signals the
 * real capture adapter (AUG-11) would add aren't available from run/test
 * ids alone, so they stay missing (NaN), never guessed. */
export interface Tier0PlatformEvidence {
  errorMessage: string;
  framework?: (typeof FRAMEWORKS)[number];
  flakeRate50?: number; // 0-1
  runs50?: number;
  failedCount50?: number;
}

export function buildTier0Features(evidence: Tier0PlatformEvidence): Record<string, number> {
  const errorClass = classifyTier0ErrorClass(evidence.errorMessage);
  const f: Record<string, number> = {
    error_class_code: codeOf(errorClass, ERROR_CLASSES),
    action_code: NaN, // not derivable from platform failure rows
    locator_strategy_code: NaN,
    framework_code: codeOf(evidence.framework, FRAMEWORKS),
    capture_level_code: codeOf("full", CAPTURE_LEVELS),
    diff_files_changed: NaN,
    diff_lines_added: NaN,
    diff_lines_removed: NaN,
    diff_touches_test_file: NaN,
    diff_touches_selector_file: NaN,
    diff_locator_values_removed: NaN,
    dom_locator_found: NaN,
    memory_runs_50: numOrNaN(evidence.runs50),
    memory_flake_rate_50: numOrNaN(evidence.flakeRate50),
    memory_failed_count_50: numOrNaN(evidence.failedCount50),
    memory_signature_repeat_count: NaN,
  };
  const ordered: Record<string, number> = {};
  for (const k of NUMERIC_FEATURES) ordered[k] = f[k] as number;
  return ordered;
}

function flatten(node: Tier0TreeNode, out: Map<number, Tier0TreeNode>): void {
  out.set(node.nodeid, node);
  for (const child of node.children ?? []) flatten(child, out);
}
function evalTree(node: Tier0TreeNode, byId: Map<number, Tier0TreeNode>, features: Record<string, number>): number {
  if (node.leaf !== undefined) return node.leaf;
  const value = features[node.split as string];
  let nextId: number;
  if (value === undefined || Number.isNaN(value)) nextId = node.missing as number;
  else if (value < (node.split_condition as number)) nextId = node.yes as number;
  else nextId = node.no as number;
  return evalTree(byId.get(nextId) as Tier0TreeNode, byId, features);
}
function softmax(margins: number[]): number[] {
  const m = Math.max(...margins);
  const exps = margins.map((x) => Math.exp(x - m));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((x) => x / total);
}

export interface Tier0Decision {
  task: string;
  decision: Tier0TriageClass | "defer";
  value: Tier0TriageClass | null;
  p: number;
  probabilities: Record<string, number>;
}

export function tier0Decide(model: Tier0Model, features: Record<string, number>): Tier0Decision {
  const margins = [...model.base_score];
  model.trees.forEach((tree, i) => {
    const classIdx = i % model.num_class;
    const byId = new Map<number, Tier0TreeNode>();
    flatten(tree, byId);
    margins[classIdx] += evalTree(byId.get(0) as Tier0TreeNode, byId, features);
  });
  const probs = softmax(margins);
  let bestIdx = 0;
  for (let k = 1; k < model.num_class; k++) if (probs[k]! > probs[bestIdx]!) bestIdx = k;
  const bestP = probs[bestIdx]!;
  const isDefer = bestP < model.decision.defer_threshold;
  const probabilities: Record<string, number> = {};
  model.classes.forEach((c, k) => (probabilities[c] = Number(probs[k]!.toFixed(6))));
  return {
    task: model.task,
    decision: isDefer ? "defer" : (model.classes[bestIdx] as Tier0TriageClass),
    value: isDefer ? null : (model.classes[bestIdx] as Tier0TriageClass),
    p: Number(bestP.toFixed(6)),
    probabilities,
  };
}

export function classifyFailureWithTier0(model: Tier0Model, evidence: Tier0PlatformEvidence): Tier0Decision {
  return tier0Decide(model, buildTier0Features(evidence));
}

// ── S3 (selector survival) / S4 (impact) — AUG-19 heads, PoC depth. ──
// `tier0Decide` above is already model-agnostic (classes/trees/base_score/
// decision.defer_threshold all come from the model document), so these two
// tracks only need their own feature builders — see ostra-tier0's
// QUESTIONS.md finding #3 for how the models were trained and the two
// class-imbalance bugs caught along the way. Feature order mirrors
// ostra_tier0/schema.py's S3_NUMERIC_FEATURES / S4_NUMERIC_FEATURES exactly.

const LOCATOR_STRATEGIES = ["css", "xpath", "test_id", "text", "role", "none"] as const;
const S3_NUMERIC_FEATURES = [
  "locator_strategy_code",
  "dom_locator_found",
  "history_releases_count",
  "history_latest_resolve_rate",
  "history_mean_resolve_rate",
  "history_trend",
] as const;
const S4_NUMERIC_FEATURES = [
  "diff_files_changed",
  "diff_lines_added",
  "diff_lines_removed",
  "diff_touches_test_file",
  "diff_touches_selector_file",
  "candidate_co_change_rate",
  "candidate_historical_fail_rate",
] as const;

export type Tier0SelectorSurvivalClass = "survives" | "breaks";
export type Tier0ImpactClass = "not_impacted" | "impacted";

function boolToNum(v: boolean | undefined | null): number {
  return v === undefined || v === null ? NaN : v ? 1 : 0;
}

/** Evidence the capture adapter (AUG-11's `LocatorContext`) would produce —
 * no platform client derives this today, so it arrives as tool input
 * verbatim rather than being fetched internally (unlike `tr_classify_failure`,
 * which CAN derive its evidence from run/test ids). */
export interface Tier0SelectorEvidence {
  strategy?: (typeof LOCATOR_STRATEGIES)[number];
  domLocatorFound?: boolean;
  /** Per-release resolve rate, oldest first. Empty/absent when no history exists. */
  history?: Array<{ release: string; resolveRate?: number }>;
}

export function buildTier0S3Features(evidence: Tier0SelectorEvidence): Record<string, number> {
  const rates = (evidence.history ?? [])
    .map((h) => h.resolveRate)
    .filter((r): r is number => r !== undefined && r !== null);
  const f: Record<string, number> = {
    locator_strategy_code: codeOf(evidence.strategy, LOCATOR_STRATEGIES),
    dom_locator_found: boolToNum(evidence.domLocatorFound),
    history_releases_count: evidence.history?.length ?? 0,
    history_latest_resolve_rate: rates.length ? rates[rates.length - 1]! : NaN,
    history_mean_resolve_rate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : NaN,
    history_trend: rates.length >= 2 ? rates[rates.length - 1]! - rates[0]! : NaN,
  };
  const ordered: Record<string, number> = {};
  for (const k of S3_NUMERIC_FEATURES) ordered[k] = f[k] as number;
  return ordered;
}

export function predictSelectorSurvival(model: Tier0Model, evidence: Tier0SelectorEvidence): Tier0Decision {
  return tier0Decide(model, buildTier0S3Features(evidence));
}

/** Evidence the capture adapter (AUG-11's `S4Payload`, one candidate) would
 * produce — same "arrives as tool input verbatim" reasoning as S3 above. */
export interface Tier0ImpactEvidence {
  diffFilesChanged?: number;
  diffLinesAdded?: number;
  diffLinesRemoved?: number;
  diffTouchesTestFile?: boolean;
  diffTouchesSelectorFile?: boolean;
  coChangeRate?: number;
  historicalFailRate?: number;
}

export function buildTier0S4Features(evidence: Tier0ImpactEvidence): Record<string, number> {
  const f: Record<string, number> = {
    diff_files_changed: numOrNaN(evidence.diffFilesChanged),
    diff_lines_added: numOrNaN(evidence.diffLinesAdded),
    diff_lines_removed: numOrNaN(evidence.diffLinesRemoved),
    diff_touches_test_file: boolToNum(evidence.diffTouchesTestFile),
    diff_touches_selector_file: boolToNum(evidence.diffTouchesSelectorFile),
    candidate_co_change_rate: numOrNaN(evidence.coChangeRate),
    candidate_historical_fail_rate: numOrNaN(evidence.historicalFailRate),
  };
  const ordered: Record<string, number> = {};
  for (const k of S4_NUMERIC_FEATURES) ordered[k] = f[k] as number;
  return ordered;
}

export function predictTestImpact(model: Tier0Model, evidence: Tier0ImpactEvidence): Tier0Decision {
  return tier0Decide(model, buildTier0S4Features(evidence));
}
