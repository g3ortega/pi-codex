export type BuiltinAlternative = {
  tool: "read" | "grep" | "find" | "ls";
  reason: string;
};

const SHELL_ESCAPE_OR_REDIRECTION_PATTERN = /(?:^|[^\w])(>|>>|<|<<|tee\b|\$\(|`)/;
const SHELL_CHAIN_PATTERN = /(?:&&|\|\||;|\n)/;
const RISKY_FIND_FLAG_PATTERN = /\s-(?:exec|execdir|ok|delete|print0|fprint|fprintf|fls)\b/;

function trimCommand(command: string): string {
  return command.trim();
}

function isSimpleCommand(command: string): boolean {
  const trimmed = trimCommand(command);
  return trimmed.length > 0 && !SHELL_ESCAPE_OR_REDIRECTION_PATTERN.test(trimmed) && !SHELL_CHAIN_PATTERN.test(trimmed);
}

export function detectBuiltinAlternativeForBash(command: string): BuiltinAlternative | null {
  const trimmed = trimCommand(command);
  if (!isSimpleCommand(trimmed)) {
    return null;
  }

  if (/^find\b/i.test(trimmed)) {
    if (RISKY_FIND_FLAG_PATTERN.test(trimmed)) {
      return null;
    }
    if (/\|\s*sort(?:\s|$)/i.test(trimmed) || /^find\b/i.test(trimmed)) {
      return {
        tool: "find",
        reason: "Use the built-in `find` tool for file discovery instead of bash.",
      };
    }
  }

  if (/^ls\b/i.test(trimmed)) {
    return {
      tool: "ls",
      reason: "Use the built-in `ls` tool for directory listing instead of bash.",
    };
  }

  if (/^(?:grep|rg)\b/i.test(trimmed)) {
    return {
      tool: "grep",
      reason: "Use the built-in `grep` tool for content search instead of bash.",
    };
  }

  if (/^(?:cat|sed\s+-n\s+['"]?\d+(?:,\d+)?p['"]?)\b/i.test(trimmed)) {
    return {
      tool: "read",
      reason: "Use the built-in `read` tool for file content inspection instead of bash.",
    };
  }

  return null;
}
