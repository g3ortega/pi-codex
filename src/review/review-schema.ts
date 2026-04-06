export type ReviewSeverity = "critical" | "high" | "medium" | "low";
export type ReviewVerdict = "approve" | "needs-attention";

export interface ReviewFinding {
  severity: ReviewSeverity;
  title: string;
  body: string;
  file: string;
  line_start: number | null;
  line_end: number | null;
  confidence: number | null;
  recommendation: string;
}

export interface StructuredReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  next_steps: string[];
}

export interface ParsedReviewPayload {
  parsed: StructuredReviewResult | null;
  parseError: string | null;
  rawOutput: string;
}

export interface StoredReviewRun {
  id: string;
  kind: "review" | "adversarial-review";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  repoRoot: string;
  branch: string;
  targetLabel: string;
  targetMode: "working-tree" | "branch";
  targetBaseRef?: string;
  modelProvider: string;
  modelId: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  focusText?: string;
  result: StructuredReviewResult | null;
  parseError: string | null;
  rawOutput: string;
}

function severityRank(severity: ReviewSeverity): number {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function extractJsonObject(text: string): string {
  const trimmed = stripCodeFence(text);
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function normalizeSeverity(value: unknown): ReviewSeverity {
  return value === "critical" || value === "high" || value === "medium" ? value : "low";
}

function normalizeLine(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : null;
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeFinding(value: unknown, index: number): ReviewFinding {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const lineStart = normalizeLine(source.line_start);
  const lineEndRaw = normalizeLine(source.line_end);
  const lineEnd = lineStart && lineEndRaw && lineEndRaw >= lineStart ? lineEndRaw : lineStart;

  return {
    severity: normalizeSeverity(source.severity),
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    confidence: normalizeConfidence(source.confidence),
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : "",
  };
}

export function parseStructuredReviewOutput(rawOutput: string): ParsedReviewPayload {
  const candidate = extractJsonObject(rawOutput);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return {
      parsed: validateStructuredReviewShape(parsed),
      parseError: null,
      rawOutput,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      parsed: null,
      parseError: message,
      rawOutput,
    };
  }
}

export function validateStructuredReviewShape(data: unknown): StructuredReviewResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Expected a top-level JSON object.");
  }

  const source = data as Record<string, unknown>;
  if (source.verdict !== "approve" && source.verdict !== "needs-attention") {
    throw new Error("Missing valid `verdict`.");
  }
  if (typeof source.summary !== "string" || !source.summary.trim()) {
    throw new Error("Missing string `summary`.");
  }
  if (!Array.isArray(source.findings)) {
    throw new Error("Missing array `findings`.");
  }
  if (!Array.isArray(source.next_steps)) {
    throw new Error("Missing array `next_steps`.");
  }

  const result: StructuredReviewResult = {
    verdict: source.verdict,
    summary: source.summary.trim(),
    findings: source.findings.map((entry, index) => normalizeFinding(entry, index)),
    next_steps: source.next_steps
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim()),
  };

  result.findings.sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  return result;
}
