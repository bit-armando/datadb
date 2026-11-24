import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConnectionProfile, SchemaNode, Session } from "@/lib/types";
import type { DatabaseDriver } from "./db/types";
import { getSession, getSessionSchema, type StoredSession } from "./sessions";

interface GlobalSessionsStore {
  sessions: Map<string, StoredSession>;
  shutdownRegistered: boolean;
  cleanupStarted: boolean;
  schemaCache: Map<string, { schema: SchemaNode[]; fetchedAt: number }>;
}

const GLOBAL_KEY = "__gestordb_sessions__";

function getGlobalStore(): GlobalSessionsStore {
  // Ensure the lazy global store exists before reading it directly.
  getSession("__init__");
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as GlobalSessionsStore;
}

test("getSessionSchema throws Session not found for unknown sessionId even if schemaCache holds an entry", async () => {
  await assert.rejects(() => getSessionSchema("missing-session-id"), /Session not found/);

  const store = getGlobalStore();
  const orphanId = "orphan-cached-session";
  store.schemaCache.set(orphanId, { schema: [], fetchedAt: Date.now() });
  try {
    await assert.rejects(() => getSessionSchema(orphanId), /Session not found/);
  } finally {
    store.schemaCache.delete(orphanId);
  }
});

test("getSessionSchema refreshes lastUsedAt on both cache miss and cache hit", async () => {
  const store = getGlobalStore();
  const sessionId = "test-session-schema-last-used";
  let getSchemaCalls = 0;
  const expectedSchema: SchemaNode[] = [
    { name: "public", tables: [], routines: [], triggers: [] },
  ];

  const driver = {
    getSchema: async () => {
      getSchemaCalls++;
      return expectedSchema;
    },
  } as unknown as DatabaseDriver;

  const config: ConnectionProfile = {
    id: "profile-1",
    name: "Test DB",
    type: "postgres",
    host: "localhost",
    port: 5432,
    user: "postgres",
    password: "",
    database: "postgres",
  };

  const session: Session = {
    sessionId,
    name: config.name,
    type: config.type,
    database: config.database,
    profileId: config.id,
  };

  const initialLastUsedAt = Date.now() - 60_000;
  const stored: StoredSession = {
    driver,
    config,
    session,
    lastUsedAt: initialLastUsedAt,
    queryHistory: [],
  };

  store.sessions.set(sessionId, stored);
  try {
    const beforeMiss = Date.now();
    const firstSchema = await getSessionSchema(sessionId);
    assert.deepEqual(firstSchema, expectedSchema);
    assert.equal(getSchemaCalls, 1);
    assert.ok(stored.lastUsedAt >= beforeMiss);
    assert.ok(stored.lastUsedAt > initialLastUsedAt);

    const staleLastUsedAt = Date.now() - 30_000;
    stored.lastUsedAt = staleLastUsedAt;

    const beforeHit = Date.now();
    const secondSchema = await getSessionSchema(sessionId);
    assert.deepEqual(secondSchema, expectedSchema);
    assert.equal(getSchemaCalls, 1);
    assert.ok(stored.lastUsedAt >= beforeHit);
    assert.ok(stored.lastUsedAt > staleLastUsedAt);
  } finally {
    store.sessions.delete(sessionId);
    store.schemaCache.delete(sessionId);
  }
});
