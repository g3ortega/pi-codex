export type CodexReviewKind = "review" | "adversarial-review" | "adversarial-mental-models-review";

export function reviewKindTitle(kind: CodexReviewKind): string {
  switch (kind) {
    case "adversarial-review":
      return "Codex Adversarial Review";
    case "adversarial-mental-models-review":
      return "Codex Adversarial Mental Models Review";
    default:
      return "Codex Review";
  }
}

export function reviewKindIdPrefix(kind: CodexReviewKind): string {
  switch (kind) {
    case "adversarial-review":
      return "adversarial-review";
    case "adversarial-mental-models-review":
      return "adversarial-mental-models-review";
    default:
      return "review";
  }
}
