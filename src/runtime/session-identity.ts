type SessionManagerLike = {
  getSessionId?: () => string;
  getSessionFile?: () => string | undefined;
};

type SessionContextLike = {
  cwd: string;
  sessionManager: SessionManagerLike;
};

export type CodexSessionIdentity = {
  id: string;
  file?: string;
  cwd: string;
};

export function resolveSessionIdentity(ctx: SessionContextLike): CodexSessionIdentity {
  const id = ctx.sessionManager.getSessionId?.()
    ?? ctx.sessionManager.getSessionFile?.()
    ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    file: ctx.sessionManager.getSessionFile?.(),
    cwd: ctx.cwd,
  };
}
