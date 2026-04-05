import { splitShellLikeArgs } from "./arg-parser.js";

function normalizePathLike(value: string): string {
  return value.replace(/\\/g, "/").trim();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimShellToken(token: string): string {
  return token
    .replace(/^[("'`]+/, "")
    .replace(/^(?:\d*>>?|\d*<<?|<<-?)/, "")
    .replace(/[)"'`;|&]+$/, "");
}

function matchesProtectedEntry(pathValue: string, protectedEntry: string): boolean {
  const normalizedPath = normalizePathLike(pathValue);
  const normalizedEntry = normalizePathLike(protectedEntry);

  if (!normalizedPath || !normalizedEntry) {
    return false;
  }

  if (normalizedEntry.endsWith("/")) {
    const directoryEntry = normalizedEntry.replace(/\/+$/, "");
    return (
      normalizedPath === directoryEntry ||
      normalizedPath.startsWith(`${directoryEntry}/`) ||
      normalizedPath.endsWith(`/${directoryEntry}`) ||
      normalizedPath.includes(`/${directoryEntry}/`)
    );
  }

  return normalizedPath === normalizedEntry || normalizedPath.endsWith(`/${normalizedEntry}`);
}

export function findProtectedPathMatch(pathValue: string, protectedPaths: string[]): string | null {
  for (const protectedEntry of protectedPaths) {
    if (matchesProtectedEntry(pathValue, protectedEntry)) {
      return protectedEntry;
    }
  }
  return null;
}

function isLikelyReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  if (/[>|]|\btee\b/.test(trimmed)) {
    return false;
  }

  // Treat compound commands and command substitution as unsafe for the read-only fast path.
  if (/(?:&&|\|\||;|\n|\$\(|`)/.test(trimmed)) {
    return false;
  }

  return [
    /^cat\b/,
    /^echo\b/,
    /^head\b/,
    /^tail\b/,
    /^less\b/,
    /^more\b/,
    /^printf\b/,
    /^grep\b/,
    /^rg\b/,
    /^find\b/,
    /^ls\b/,
    /^stat\b/,
    /^file\b/,
    /^wc\b/,
    /^sed\s+-n\b/,
    /^git\s+(?:diff|show|status|log|rev-parse|ls-files|grep)\b/,
  ].some((pattern) => pattern.test(trimmed));
}

function commandReferencesProtectedPath(command: string, protectedEntry: string): boolean {
  const normalizedEntry = normalizePathLike(protectedEntry).replace(/\/+$/, "");
  if (!normalizedEntry) {
    return false;
  }

  const pathPattern = escapeRegex(normalizedEntry).replace(/\//g, "[/\\\\]");
  const boundary = String.raw`(?:^|[\s"'` + "`" + String.raw`;|&()<>])`;
  const trailingBoundary = String.raw`(?:$|[\s"'` + "`" + String.raw`;|&()<>])`;
  const relativePattern = String.raw`(?:\./|\.\./)*`;
  const matcher = new RegExp(`${boundary}${relativePattern}${pathPattern}${trailingBoundary}`);
  return matcher.test(command);
}

export function findProtectedPathInBashCommand(command: string, protectedPaths: string[]): string | null {
  const tokens = splitShellLikeArgs(command)
    .map((token) => trimShellToken(token))
    .filter(Boolean);

  const matchedProtectedPathFromTokens = tokens
    .map((token) => findProtectedPathMatch(token, protectedPaths))
    .find((entry): entry is string => Boolean(entry));

  const matchedProtectedPath =
    matchedProtectedPathFromTokens ??
    protectedPaths.find((entry) => commandReferencesProtectedPath(command, entry)) ??
    null;

  if (!matchedProtectedPath) {
    return null;
  }

  return isLikelyReadOnlyShellCommand(command) ? null : matchedProtectedPath;
}
