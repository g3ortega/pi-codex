import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { splitShellLikeArgs } from "./arg-parser.js";

export const BACKGROUND_READONLY_ENV = "PI_CODEX_BACKGROUND_READONLY";

type BashConfirmWhitelistEntry = {
  type: "exact" | "pattern";
  value: string;
  addedAt: string;
  note?: string;
  source?: "user" | "ai";
};

type BashConfirmWhitelistData = {
  entries: BashConfirmWhitelistEntry[];
  version: number;
};

function normalizePathLike(value: string): string {
  return value.replace(/\\/g, "/").trim();
}

function resolveExistingOrLexicalPath(baseRoot: string, pathValue: string): string {
  const lexicalPath = isAbsolute(pathValue) ? resolve(pathValue) : resolve(baseRoot, pathValue);
  try {
    return realpathSync(lexicalPath);
  } catch {
    return lexicalPath;
  }
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

function isPathInsideRoot(scopeRoot: string, resolutionCwd: string, candidatePath: string): boolean {
  const resolvedRoot = resolveExistingOrLexicalPath(scopeRoot, scopeRoot);
  const resolvedCandidate = resolveExistingOrLexicalPath(resolutionCwd, candidatePath);
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function looksLikeResolvablePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === "." || trimmed === "..") {
    return true;
  }
  if (isAbsolute(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return true;
  }
  if (/[\\/]/.test(trimmed)) {
    return true;
  }
  return trimmed.split(/[\\/]+/).some((segment) => segment === "." || segment === "..");
}

function extractReadOnlyToolPath(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const pathValue = (input as { path?: unknown }).path;
  return typeof pathValue === "string" && pathValue.trim() ? pathValue.trim() : null;
}

export function findReadOnlyScopeViolation(toolName: string, input: unknown, scopeRoot: string, resolutionCwd = scopeRoot): string | null {
  if (!["read", "grep", "find", "ls"].includes(toolName)) {
    return null;
  }
  const targetPath = extractReadOnlyToolPath(input);
  if (!targetPath) {
    return null;
  }
  return isPathInsideRoot(scopeRoot, resolutionCwd, targetPath) ? null : targetPath;
}

function collectFindPaths(tokens: string[]): string[] {
  const paths: string[] = [];
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith("-")) {
    const token = tokens[index];
    if (token === "-D" || token === "-O") {
      index += 2;
      continue;
    }
    index += 1;
  }
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("-") || token === "!" || token === "(" || token === ")" || token === ",") {
      break;
    }
    paths.push(token);
  }
  return paths;
}

function collectLsPaths(tokens: string[]): string[] {
  return tokens.slice(1).filter((token) => !token.startsWith("-"));
}

function collectSedPaths(tokens: string[]): string[] {
  const paths: string[] = [];
  let consumedInlineScript = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-n" || token === "--quiet" || token === "--silent") {
      continue;
    }
    if (token === "-e" || token === "--expression" || token === "-f" || token === "--file") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    if (!consumedInlineScript) {
      consumedInlineScript = true;
      continue;
    }
    paths.push(token);
  }
  return paths;
}

function bashSegmentScopePaths(tokens: string[]): string[] {
  if (tokens.length === 0) {
    return [];
  }
  if (tokens[0] === "git") {
    const paths: string[] = [];
    for (let index = 2; index < tokens.length; index += 1) {
      const token = tokens[index];
      const previous = tokens[index - 1];
      if (previous === "-C") {
        paths.push(token);
        continue;
      }
      if (/^--(?:git-dir|work-tree)=/.test(token)) {
        const [, value = ""] = token.split("=", 2);
        if (value) {
          paths.push(value);
        }
      }
    }
    const separatorIndex = tokens.indexOf("--");
    if (separatorIndex >= 0) {
      for (const token of tokens.slice(separatorIndex + 1)) {
        if (looksLikeResolvablePath(token)) {
          paths.push(token);
        }
      }
    }
    return paths;
  }
  if (tokens[0] === "find") {
    return collectFindPaths(tokens);
  }
  if (tokens[0] === "ls") {
    return collectLsPaths(tokens);
  }
  if (tokens[0] === "sed") {
    return collectSedPaths(tokens);
  }
  return [];
}

export function findReadOnlyScopeViolationInBashCommand(command: string, scopeRoot: string, resolutionCwd = scopeRoot): string | null {
  const trimmed = command.trim();
  if (!trimmed || !isLikelyReadOnlyShellCommand(trimmed)) {
    return null;
  }

  const segments = splitReadOnlyShellSegments(trimmed);
  if (!segments) {
    return null;
  }

  for (const segment of segments) {
    const tokens = splitShellLikeArgs(segment);
    if (tokens.length === 0) {
      continue;
    }
    for (const token of bashSegmentScopePaths(tokens)) {
      if (looksLikeResolvablePath(token) && !isPathInsideRoot(scopeRoot, resolutionCwd, token)) {
        return token;
      }
    }
  }

  return null;
}

export function isLikelyReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  if (/[>]|(?:^|[\s;|&])tee\b/.test(trimmed)) {
    return false;
  }

  if (/(?:\n|\$\(|`|<\()/.test(trimmed)) {
    return false;
  }

  const segments = splitReadOnlyShellSegments(trimmed);
  if (!segments || segments.length === 0) {
    return false;
  }

  return segments.every((segment) => isLikelyReadOnlyShellSegment(segment));
}

function loadBashConfirmWhitelist(cwd: string): BashConfirmWhitelistData {
  const whitelistPath = join(cwd, ".pi", "bash-confirm-whitelist.json");
  if (!existsSync(whitelistPath)) {
    return { entries: [], version: 2 };
  }

  try {
    const parsed = JSON.parse(readFileSync(whitelistPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { entries: [], version: 2 };
    }
    const rawEntries = Array.isArray((parsed as { entries?: unknown[] }).entries)
      ? (parsed as { entries: unknown[] }).entries
      : [];
    const entries = rawEntries.filter((entry): entry is BashConfirmWhitelistEntry => {
      return Boolean(
        entry &&
        typeof entry === "object" &&
        (((entry as { type?: unknown }).type === "exact") || ((entry as { type?: unknown }).type === "pattern")) &&
        typeof (entry as { value?: unknown }).value === "string",
      );
    });
    return { entries, version: 2 };
  } catch {
    return { entries: [], version: 2 };
  }
}

function saveBashConfirmWhitelist(cwd: string, data: BashConfirmWhitelistData): boolean {
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "bash-confirm-whitelist.json"), JSON.stringify({ ...data, version: 2 }, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function ensureHeadlessReadOnlyBashWhitelisted(cwd: string, command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || !isLikelyReadOnlyShellCommand(trimmed)) {
    return false;
  }

  const whitelist = loadBashConfirmWhitelist(cwd);
  if (whitelist.entries.some((entry) => entry.type === "exact" && entry.value === trimmed)) {
    return true;
  }

  whitelist.entries.push({
    type: "exact",
    value: trimmed,
    addedAt: new Date().toISOString(),
    note: "Auto-added by pi-codex for safe headless readonly bash inspection",
    source: "ai",
  });
  whitelist.version = 2;
  return saveBashConfirmWhitelist(cwd, whitelist);
}

function splitReadOnlyShellSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escape = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escape = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      current += char;
      quote = char;
      continue;
    }

    if (char === "&" && next === "&") {
      segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }

    if (char === "|" && next === "|") {
      segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }

    if (char === ";" || char === "|") {
      segments.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (quote) {
    return null;
  }

  segments.push(current.trim());
  return segments.filter(Boolean);
}

function isLikelyReadOnlyShellSegment(segment: string): boolean {
  if (isLikelyReadOnlyGitSegment(segment)) {
    return true;
  }

  if (isLikelyReadOnlyFindSegment(segment)) {
    return true;
  }

  if (isLikelyReadOnlySedSegment(segment)) {
    return true;
  }

  return [
    /^echo\b/,
    /^pwd\b/,
  ].some((pattern) => pattern.test(segment));
}

function isLikelyReadOnlyFindSegment(segment: string): boolean {
  const tokens = splitShellLikeArgs(segment);
  if (tokens.length === 0 || tokens[0] !== "find") {
    return false;
  }

  return !tokens.some((token) => (
    token === "-delete"
    || token === "-exec"
    || token === "-execdir"
    || token === "-ok"
    || token === "-okdir"
    || token === "-fprint"
    || token === "-fprintf"
    || token === "-fls"
  ));
}

const PRINT_ONLY_SED_SCRIPT = /^(?:[\d$,\s]*p\s*;?\s*)+$/;

function isLikelyReadOnlySedSegment(segment: string): boolean {
  const tokens = splitShellLikeArgs(segment);
  if (tokens.length === 0 || tokens[0] !== "sed") {
    return false;
  }

  const scripts: string[] = [];
  let sawQuiet = false;
  let consumedInlineScript = false;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-n" || token === "--quiet" || token === "--silent") {
      sawQuiet = true;
      continue;
    }

    if (token === "-e" || token === "--expression") {
      const next = tokens[index + 1];
      if (!next) {
        return false;
      }
      scripts.push(next);
      index += 1;
      continue;
    }

    if (token === "-f" || token === "--file" || token === "-i" || /^--in-place(?:=|$)/.test(token)) {
      return false;
    }

    if (token.startsWith("-")) {
      return false;
    }

    if (!consumedInlineScript) {
      scripts.push(token);
      consumedInlineScript = true;
      continue;
    }

    // Remaining operands are input files and are read-only.
  }

  return sawQuiet && scripts.length > 0 && scripts.every((script) => PRINT_ONLY_SED_SCRIPT.test(script.trim()));
}

function isLikelyReadOnlyGitSegment(segment: string): boolean {
  const tokens = splitShellLikeArgs(segment);
  if (tokens.length < 2 || tokens[0] !== "git") {
    return false;
  }

  if (tokens.some((token) => token === "-o" || /^--output(?:=|$)/.test(token))) {
    return false;
  }

  const subcommand = tokens[1];
  if (["diff", "show", "status", "log", "rev-parse", "ls-files", "grep", "merge-base", "blame", "rev-list", "diff-tree"].includes(subcommand)) {
    return true;
  }

  if (subcommand === "branch") {
    return tokens.slice(2).every((token) => (
      token.startsWith("-")
        ? ["-a", "-r", "-v", "-vv", "--list", "--show-current", "--merged", "--no-merged", "--contains", "--no-contains", "--points-at", "--format", "--sort", "--column", "--color", "--omit-empty"]
          .some((allowed) => token === allowed || token.startsWith(`${allowed}=`))
        : false
    ));
  }

  if (subcommand === "remote") {
    const remoteSubcommand = tokens[2];
    if (!remoteSubcommand) {
      return true;
    }
    if (!["show", "get-url"].includes(remoteSubcommand)) {
      return false;
    }
    return tokens.slice(3).every((token) => !token.startsWith("-") || token === "-v" || token === "--verbose");
  }

  if (subcommand === "cat-file") {
    return tokens.slice(2).every((token, index) => (
      index === 0 && token.startsWith("-")
        ? ["-p", "-t", "-s", "-e", "--batch", "--batch-check"].includes(token)
        : true
    ));
  }

  return false;
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
