import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@/lib/api-error";
import {
  createSessionReconnectCoordinator,
  isSessionExpiredError,
  resolveReconnectTarget,
  type WakeTarget,
} from "@/lib/session-reconnect";
import type { ConsoleBinding, Session } from "@/lib/types";

const BASE_SESSION: Session = {
  sessionId: "s-1",
  name: "Prod DB",
  type: "postgres",
  database: "analytics",
  color: "#E5484D",
  profileId: "profile-1",
  readOnly: false,
};

const BASE_BINDING: ConsoleBinding = {
  profileId: "profile-1",
  name: "Prod DB",
  type: "postgres",
  database: "default_db",
  color: "#E5484D",
  readOnly: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("isSessionExpiredError matches worker session-not-found errors only", () => {
  assert.equal(isSessionExpiredError("Session not found"), true);
  assert.equal(isSessionExpiredError("Error: Session not found"), true);
  assert.equal(isSessionExpiredError(new ApiError("Session not found", 401)), true);
  assert.equal(isSessionExpiredError(new ApiError("Session not found", 404)), true);
  assert.equal(isSessionExpiredError(new ApiError("Session not found", 500)), true);

  assert.equal(isSessionExpiredError("The SSO session token is expired"), false);
  assert.equal(isSessionExpiredError(new Error("The SSO session token is expired")), false);
  assert.equal(isSessionExpiredError("certificate has expired"), false);
  assert.equal(isSessionExpiredError(new Error("certificate has expired")), false);
  assert.equal(isSessionExpiredError(new Error('syntax error at or near "SELECT"')), false);
  assert.equal(isSessionExpiredError(new Error("ECONNREFUSED")), false);
});

test("resolveReconnectTarget prefers overrideDatabase, then session database, then binding", () => {
  assert.deepEqual(resolveReconnectTarget(BASE_SESSION, BASE_BINDING), {
    profileId: "profile-1",
    database: "analytics",
  });
  assert.deepEqual(resolveReconnectTarget(BASE_SESSION, BASE_BINDING, "billing"), {
    profileId: "profile-1",
    database: "billing",
  });
  assert.deepEqual(resolveReconnectTarget(null, BASE_BINDING), {
    profileId: "profile-1",
    database: "default_db",
  });
  assert.equal(resolveReconnectTarget({ ...BASE_SESSION, profileId: undefined }, null), null);
  assert.equal(resolveReconnectTarget(null, null), null);
});

test("runWithSession succeeds on a live session without calling wake", async () => {
  let wakeCount = 0;
  let reconnectEvents = 0;
  let sessionChanges = 0;

  const coordinator = createSessionReconnectCoordinator({
    wake: async () => {
      wakeCount += 1;
      return { session: BASE_SESSION };
    },
    onReconnecting: () => {
      reconnectEvents += 1;
    },
  });

  const out = await coordinator.runWithSession(
    {
      consoleId: "c-1",
      session: BASE_SESSION,
      binding: BASE_BINDING,
      onSessionChange: () => {
        sessionChanges += 1;
      },
    },
    async (session) => `ran:${session.sessionId}`
  );

  assert.equal(out.result, "ran:s-1");
  assert.equal(out.session, BASE_SESSION);
  assert.equal(wakeCount, 0);
  assert.equal(reconnectEvents, 0);
  assert.equal(sessionChanges, 0);
});

test("runWithSession wakes once on expired session, preserves database, and retries", async () => {
  const wakeTargets: WakeTarget[] = [];
  const reconnecting: Array<{ reason: "expired" | "dormant"; target: WakeTarget }> = [];
  const sessionChanges: Session[] = [];
  const fresh: Session = { ...BASE_SESSION, sessionId: "s-2", database: "analytics" };

  const coordinator = createSessionReconnectCoordinator({
    wake: async (target) => {
      wakeTargets.push(target);
      return { session: { ...fresh, database: target.database } };
    },
    onReconnecting: (info) => reconnecting.push(info),
  });

  const attempts: string[] = [];
  const out = await coordinator.runWithSession(
    {
      consoleId: "c-1",
      session: BASE_SESSION,
      binding: BASE_BINDING,
      onSessionChange: (s) => sessionChanges.push(s),
    },
    async (session) => {
      attempts.push(session.sessionId);
      if (session.sessionId === "s-1") {
        throw new ApiError("Session not found", 401);
      }
      return { rows: 42 };
    }
  );

  assert.deepEqual(attempts, ["s-1", "s-2"]);
  assert.deepEqual(wakeTargets, [{ profileId: "profile-1", database: "analytics" }]);
  assert.deepEqual(reconnecting, [
    { reason: "expired", target: { profileId: "profile-1", database: "analytics" } },
  ]);
  assert.equal(sessionChanges.length, 1);
  assert.equal(sessionChanges[0].sessionId, "s-2");
  assert.equal(out.session.sessionId, "s-2");
  assert.deepEqual(out.result, { rows: 42 });
});

test("runWithSession does not wake on non-expired errors and rethrows original error", async () => {
  let wakeCount = 0;
  const original = new Error("The SSO session token is expired");

  const coordinator = createSessionReconnectCoordinator({
    wake: async () => {
      wakeCount += 1;
      return { session: BASE_SESSION };
    },
  });

  await assert.rejects(
    coordinator.runWithSession(
      {
        consoleId: "c-1",
        session: BASE_SESSION,
        binding: BASE_BINDING,
        onSessionChange: () => {},
      },
      async () => {
        throw original;
      }
    ),
    (err) => err === original
  );

  assert.equal(wakeCount, 0);
});

test("runWithSession throws without looping if retried operation still fails with Session not found", async () => {
  let wakeCount = 0;
  const fresh: Session = { ...BASE_SESSION, sessionId: "s-2" };

  const coordinator = createSessionReconnectCoordinator({
    wake: async () => {
      wakeCount += 1;
      return { session: fresh };
    },
  });

  await assert.rejects(
    coordinator.runWithSession(
      {
        consoleId: "c-1",
        session: BASE_SESSION,
        binding: BASE_BINDING,
        onSessionChange: () => {},
      },
      async () => {
        throw new ApiError("Session not found", 404);
      }
    ),
    (err) => err instanceof ApiError && err.message === "Session not found"
  );

  assert.equal(wakeCount, 1);
});

test("runWithSession shares one wake and one onReconnecting across concurrent expired calls on the same console", async () => {
  const gate = deferred<{ session: Session }>();
  let wakeCount = 0;
  let reconnectingCount = 0;
  const fresh: Session = { ...BASE_SESSION, sessionId: "s-fresh" };

  const coordinator = createSessionReconnectCoordinator({
    wake: async () => {
      wakeCount += 1;
      return gate.promise;
    },
    onReconnecting: () => {
      reconnectingCount += 1;
    },
  });

  const changes1: Session[] = [];
  const changes2: Session[] = [];

  const p1 = coordinator.runWithSession(
    {
      consoleId: "c-1",
      session: BASE_SESSION,
      binding: BASE_BINDING,
      onSessionChange: (s) => changes1.push(s),
    },
    async (s) => {
      if (s.sessionId === "s-1") throw new ApiError("Session not found", 401);
      return `op1:${s.sessionId}`;
    }
  );

  const p2 = coordinator.runWithSession(
    {
      consoleId: "c-1",
      session: BASE_SESSION,
      binding: BASE_BINDING,
      onSessionChange: (s) => changes2.push(s),
    },
    async (s) => {
      if (s.sessionId === "s-1") throw new ApiError("Session not found", 401);
      return `op2:${s.sessionId}`;
    }
  );

  // Let both operations fail and enter reconnect before resolving wake.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wakeCount, 1);
  assert.equal(reconnectingCount, 1);

  gate.resolve({ session: fresh });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.result, "op1:s-fresh");
  assert.equal(r2.result, "op2:s-fresh");
  assert.equal(changes1[0], fresh);
  assert.equal(changes2[0], fresh);
  assert.equal(wakeCount, 1);
  assert.equal(reconnectingCount, 1);
});

test("runWithSession reuses recent session within 15s TTL and wakes again after TTL or on new session failure", async () => {
  let clock = 1_000;
  let wakeCount = 0;
  let reconnectingCount = 0;

  const coordinator = createSessionReconnectCoordinator({
    wake: async () => {
      wakeCount += 1;
      return { session: { ...BASE_SESSION, sessionId: `s-woke-${wakeCount}` } };
    },
    onReconnecting: () => {
      reconnectingCount += 1;
    },
    now: () => clock,
  });

  // First expired call at t=1_000 -> wakes s-woke-1
  const first = await coordinator.runWithSession(
    {
      consoleId: "c-1",
      session: BASE_SESSION,
      binding: BASE_BINDING,
      onSessionChange: () => {},
    },
    async (s) => {
      if (s.sessionId === "s-1") throw new ApiError("Session not found", 401);
      return s.sessionId;
    }
  );
  assert.equal(first.result, "s-woke-1");
  assert.equal(wakeCount, 1);
  assert.equal(reconnectingCount, 1);

  // Late second call with the same stale s-1 within 15s (t=15_999) -> reuses recent s-woke-1
  clock = 15_999;
  const lateChanges: Session[] = [];
  const second = await coordinator.runWithSession(
    {
      consoleId: "c-1",
      session: BASE_SESSION,
      binding: BASE_BINDING,
      onSessionChange: (s) => lateChanges.push(s),
    },
    async (s) => {
      if (s.sessionId === "s-1") throw new ApiError("Session not found", 401);
      return s.sessionId;
    }
  );
  assert.equal(second.result, "s-woke-1");
  assert.equal(lateChanges[0].sessionId, "s-woke-1");
  assert.equal(wakeCount, 1);
  assert.equal(reconnectingCount, 1);

  // Call at >= 15_000ms (t=16_000) with same stale s-1 -> triggers a new wake
  clock = 16_000;
  const third = await coordinator.runWithSession(
    {
      consoleId: "c-1",
      session: BASE_SESSION,
      binding: BASE_BINDING,
      onSessionChange: () => {},
    },
    async (s) => {
      if (s.sessionId === "s-1") throw new ApiError("Session not found", 401);
      return s.sessionId;
    }
  );
  assert.equal(third.result, "s-woke-2");
  assert.equal(wakeCount, 2);
  assert.equal(reconnectingCount, 2);

  // Failure on the NEW session id (s-woke-2) even within 15s (t=16_500) -> triggers a new wake
  clock = 16_500;
  const fourth = await coordinator.runWithSession(
    {
      consoleId: "c-1",
      session: third.session,
      binding: BASE_BINDING,
      onSessionChange: () => {},
    },
    async (s) => {
      if (s.sessionId === "s-woke-2") throw new ApiError("Session not found", 401);
      return s.sessionId;
    }
  );
  assert.equal(fourth.result, "s-woke-3");
  assert.equal(wakeCount, 3);
  assert.equal(reconnectingCount, 3);
});

test("runWithSession reconnects separate consoleIds independently", async () => {
  let wakeCount = 0;
  const coordinator = createSessionReconnectCoordinator({
    wake: async (target) => {
      wakeCount += 1;
      return {
        session: {
          ...BASE_SESSION,
          sessionId: `fresh-${wakeCount}`,
          profileId: target.profileId,
          database: target.database,
        },
      };
    },
  });

  const [a, b] = await Promise.all([
    coordinator.runWithSession(
      { consoleId: "c-a", session: BASE_SESSION, binding: BASE_BINDING, onSessionChange: () => {} },
      async (s) => {
        if (s.sessionId === "s-1") throw new ApiError("Session not found", 401);
        return s.sessionId;
      }
    ),
    coordinator.runWithSession(
      { consoleId: "c-b", session: BASE_SESSION, binding: BASE_BINDING, onSessionChange: () => {} },
      async (s) => {
        if (s.sessionId === "s-1") throw new ApiError("Session not found", 401);
        return s.sessionId;
      }
    ),
  ]);

  assert.equal(wakeCount, 2);
  assert.notEqual(a.session.sessionId, b.session.sessionId);
});

test("runWithSession wakes a dormant console with reason 'dormant' and runs operation", async () => {
  const reasons: Array<"expired" | "dormant"> = [];
  const changes: Session[] = [];
  const woken: Session = { ...BASE_SESSION, sessionId: "s-dormant", database: "default_db" };

  const coordinator = createSessionReconnectCoordinator({
    wake: async () => ({ session: woken }),
    onReconnecting: ({ reason }) => reasons.push(reason),
  });

  const out = await coordinator.runWithSession(
    {
      consoleId: "c-dormant",
      session: null,
      binding: BASE_BINDING,
      onSessionChange: (s) => changes.push(s),
    },
    async (s) => `ok:${s.sessionId}`
  );

  assert.deepEqual(reasons, ["dormant"]);
  assert.deepEqual(changes, [woken]);
  assert.equal(out.result, "ok:s-dormant");
  assert.equal(out.session, woken);
});

test("runWithSession throws without calling wake on a disconnected console", async () => {
  let wakeCount = 0;
  const coordinator = createSessionReconnectCoordinator({
    wake: async () => {
      wakeCount += 1;
      return { session: BASE_SESSION };
    },
  });

  await assert.rejects(
    coordinator.runWithSession(
      {
        consoleId: "c-empty",
        session: null,
        binding: null,
        onSessionChange: () => {},
      },
      async () => "never"
    ),
    /no tiene una conexión asignada/i
  );

  assert.equal(wakeCount, 0);
});

test("runWithSession forwards wake databaseError to onDatabaseError", async () => {
  const dbErrors: Array<{ db: string; err: string }> = [];
  const fallbackSession: Session = { ...BASE_SESSION, sessionId: "s-fallback", database: "postgres" };

  const coordinator = createSessionReconnectCoordinator({
    wake: async () => ({
      session: fallbackSession,
      databaseError: "database \"missing_db\" does not exist",
    }),
    onDatabaseError: (db, err) => dbErrors.push({ db, err }),
  });

  const out = await coordinator.runWithSession(
    {
      consoleId: "c-db-err",
      session: null,
      binding: { ...BASE_BINDING, database: "missing_db" },
      onSessionChange: () => {},
    },
    async (s) => s.database
  );

  assert.equal(out.result, "postgres");
  assert.deepEqual(dbErrors, [
    { db: "missing_db", err: 'database "missing_db" does not exist' },
  ]);
});

test("switchDatabaseWithReconnect uses switchDb and onSessionChange when session is live", async () => {
  let wakeCount = 0;
  const changes: Session[] = [];
  const switched: Session = { ...BASE_SESSION, database: "reporting" };

  const coordinator = createSessionReconnectCoordinator({
    wake: async () => {
      wakeCount += 1;
      return { session: BASE_SESSION };
    },
  });

  const result = await coordinator.switchDatabaseWithReconnect(
    {
      consoleId: "c-1",
      session: BASE_SESSION,
      binding: BASE_BINDING,
      onSessionChange: (s) => changes.push(s),
    },
    "reporting",
    async (sid, db) => {
      assert.equal(sid, "s-1");
      assert.equal(db, "reporting");
      return switched;
    }
  );

  assert.equal(result, switched);
  assert.deepEqual(changes, [switched]);
  assert.equal(wakeCount, 0);
});

test("switchDatabaseWithReconnect wakes directly with targetDatabase when session expired", async () => {
  const wakeTargets: WakeTarget[] = [];
  const changes: Session[] = [];
  const reconnected: Session = { ...BASE_SESSION, sessionId: "s-new", database: "reporting" };

  const coordinator = createSessionReconnectCoordinator({
    wake: async (target) => {
      wakeTargets.push(target);
      return { session: reconnected };
    },
  });

  const result = await coordinator.switchDatabaseWithReconnect(
    {
      consoleId: "c-1",
      session: BASE_SESSION,
      binding: BASE_BINDING,
      onSessionChange: (s) => changes.push(s),
    },
    "reporting",
    async () => {
      throw new ApiError("Session not found", 401);
    }
  );

  assert.deepEqual(wakeTargets, [{ profileId: "profile-1", database: "reporting" }]);
  assert.deepEqual(changes, [reconnected]);
  assert.equal(result, reconnected);
});
