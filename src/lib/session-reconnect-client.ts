import { toast } from "sonner";
import { switchDatabase } from "@/lib/api";
import { wakeBinding } from "@/lib/console-wake";
import {
  createSessionReconnectCoordinator,
  isSessionExpiredError,
  type ConsoleSessionContext,
} from "@/lib/session-reconnect";
import type { Session } from "@/lib/types";

const defaultCoordinator = createSessionReconnectCoordinator({
  wake: wakeBinding,
  onReconnecting: ({ reason }) => {
    if (reason === "expired") {
      toast.info("Sesión expirada — reconectando...");
    }
  },
  onDatabaseError: (database, error) => {
    toast.warning(`No se pudo volver a la base ${database}: ${error}`);
  },
});

/**
 * Runs a console operation with automatic dormant waking and single-flight reconnection on
 * expired worker sessions, surfacing reconnect and database-fallback notifications via toast.
 */
export function runWithConsoleSession<T>(
  ctx: ConsoleSessionContext,
  operation: (session: Session) => Promise<T>
): Promise<{ result: T; session: Session }> {
  return defaultCoordinator.runWithSession(ctx, operation);
}

/**
 * Switches the console's active database, transparently reconnecting to the target database
 * if the worker session expired.
 */
export function switchDatabaseWithConsoleReconnect(
  ctx: Omit<ConsoleSessionContext, "session"> & { session: Session },
  targetDatabase: string,
  switchDb: (sessionId: string, database: string) => Promise<Session> = switchDatabase
): Promise<Session> {
  return defaultCoordinator.switchDatabaseWithReconnect(ctx, targetDatabase, switchDb);
}

export { isSessionExpiredError, type ConsoleSessionContext };
