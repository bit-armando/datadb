import type { ConsoleBinding, Session } from "@/lib/types";

const RECENT_TTL_MS = 15_000;

export type WakeTarget = Pick<ConsoleBinding, "profileId" | "database">;

/**
 * Identifies expired worker-session errors without misclassifying external expiration messages
 * (such as AWS SSO tokens or TLS certificates).
 */
export function isSessionExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /session not found/i.test(msg);
}

/**
 * Resolves the profile and database needed to wake or reconnect a console.
 */
export function resolveReconnectTarget(
  session: Session | null,
  binding?: ConsoleBinding | null,
  overrideDatabase?: string
): WakeTarget | null {
  const profileId = session?.profileId ?? binding?.profileId;
  if (!profileId) return null;
  return {
    profileId,
    database: overrideDatabase ?? session?.database ?? binding?.database,
  };
}

export interface SessionReconnectDeps {
  wake: (target: WakeTarget) => Promise<{ session: Session; databaseError?: string }>;
  onReconnecting?: (info: { reason: "expired" | "dormant"; target: WakeTarget }) => void;
  onDatabaseError?: (database: string, error: string) => void;
  now?: () => number;
}

export interface ConsoleSessionContext {
  consoleId: string;
  session: Session | null;
  binding?: ConsoleBinding | null;
  onSessionChange: (session: Session) => void;
}

interface InFlightReconnect {
  staleSessionId: string | null;
  targetProfileId: string;
  targetDatabase?: string;
  promise: Promise<Session>;
}

interface RecentReconnect {
  fromSessionId: string | null;
  targetProfileId: string;
  targetDatabase?: string;
  toSession: Session;
  at: number;
}

/**
 * Coordinates per-console lazy waking and single-flight reconnection so concurrent or closely
 * spaced operations share one `wake` call.
 */
export function createSessionReconnectCoordinator(deps: SessionReconnectDeps) {
  const inFlight = new Map<string, InFlightReconnect>();
  const recent = new Map<string, RecentReconnect>();
  const now = deps.now ?? Date.now;

  async function reconnect(params: {
    consoleId: string;
    staleSessionId: string | null;
    target: WakeTarget;
    reason: "expired" | "dormant";
    onSessionChange: (session: Session) => void;
  }): Promise<Session> {
    const { consoleId, staleSessionId, target, reason, onSessionChange } = params;

    const recentEntry = recent.get(consoleId);
    if (
      recentEntry &&
      recentEntry.fromSessionId === staleSessionId &&
      recentEntry.targetProfileId === target.profileId &&
      recentEntry.targetDatabase === target.database &&
      now() - recentEntry.at < RECENT_TTL_MS
    ) {
      onSessionChange(recentEntry.toSession);
      return recentEntry.toSession;
    }

    const active = inFlight.get(consoleId);
    if (
      active &&
      active.staleSessionId === staleSessionId &&
      active.targetProfileId === target.profileId &&
      active.targetDatabase === target.database
    ) {
      const session = await active.promise;
      onSessionChange(session);
      return session;
    }

    deps.onReconnecting?.({ reason, target });

    const promise = (async () => {
      const { session, databaseError } = await deps.wake(target);
      if (databaseError && target.database) {
        deps.onDatabaseError?.(target.database, databaseError);
      }
      recent.set(consoleId, {
        fromSessionId: staleSessionId,
        targetProfileId: target.profileId,
        targetDatabase: target.database,
        toSession: session,
        at: now(),
      });
      return session;
    })();

    inFlight.set(consoleId, {
      staleSessionId,
      targetProfileId: target.profileId,
      targetDatabase: target.database,
      promise,
    });

    try {
      const session = await promise;
      onSessionChange(session);
      return session;
    } finally {
      if (inFlight.get(consoleId)?.promise === promise) {
        inFlight.delete(consoleId);
      }
    }
  }

  async function runWithSession<T>(
    ctx: ConsoleSessionContext,
    operation: (session: Session) => Promise<T>
  ): Promise<{ result: T; session: Session }> {
    let current = ctx.session;
    if (!current) {
      const target = resolveReconnectTarget(null, ctx.binding);
      if (!target) {
        throw new Error("Esta consola no tiene una conexión asignada.");
      }
      current = await reconnect({
        consoleId: ctx.consoleId,
        staleSessionId: null,
        target,
        reason: "dormant",
        onSessionChange: ctx.onSessionChange,
      });
    }

    try {
      const result = await operation(current);
      return { result, session: current };
    } catch (err) {
      if (!isSessionExpiredError(err)) throw err;
      const target = resolveReconnectTarget(current, ctx.binding);
      if (!target) throw err;
      const fresh = await reconnect({
        consoleId: ctx.consoleId,
        staleSessionId: current.sessionId,
        target,
        reason: "expired",
        onSessionChange: ctx.onSessionChange,
      });
      const result = await operation(fresh);
      return { result, session: fresh };
    }
  }

  async function switchDatabaseWithReconnect(
    ctx: Omit<ConsoleSessionContext, "session"> & { session: Session },
    targetDatabase: string,
    switchDb: (sessionId: string, database: string) => Promise<Session>
  ): Promise<Session> {
    try {
      const updated = await switchDb(ctx.session.sessionId, targetDatabase);
      ctx.onSessionChange(updated);
      return updated;
    } catch (err) {
      if (!isSessionExpiredError(err)) throw err;
      const target = resolveReconnectTarget(ctx.session, ctx.binding, targetDatabase);
      if (!target) throw err;
      return reconnect({
        consoleId: ctx.consoleId,
        staleSessionId: ctx.session.sessionId,
        target,
        reason: "expired",
        onSessionChange: ctx.onSessionChange,
      });
    }
  }

  return {
    reconnect,
    runWithSession,
    switchDatabaseWithReconnect,
  };
}
