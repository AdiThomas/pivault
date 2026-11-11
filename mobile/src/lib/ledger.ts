/**
 * The backup ledger: a local SQLite table of camera-roll items already on the server.
 * It lets a backup pass skip tens of thousands of photos without asking the server
 * about each one. The web build uses ledger.web.ts instead.
 */
import * as SQLite from 'expo-sqlite';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function open(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('pivault-ledger.db');
      await db.execAsync(
        `PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS uploaded (
           asset_id TEXT PRIMARY KEY NOT NULL,
           uploaded_at INTEGER NOT NULL
         );`,
      );
      return db;
    })().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

const CHUNK = 400; // stay well under SQLite's bound-parameter limit

/** Which of these camera-roll ids are already recorded as backed up. */
export async function filterKnown(ids: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  if (!ids.length) return known;
  const db = await open();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const marks = chunk.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ asset_id: string }>(
      `SELECT asset_id FROM uploaded WHERE asset_id IN (${marks})`,
      chunk,
    );
    for (const row of rows) known.add(row.asset_id);
  }
  return known;
}

export async function markUploaded(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await open();
  const now = Date.now();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const values = chunk.map(() => '(?, ?)').join(',');
    const params = chunk.flatMap((id) => [id, now]);
    await db.runAsync(
      `INSERT OR REPLACE INTO uploaded (asset_id, uploaded_at) VALUES ${values}`,
      params,
    );
  }
}

export async function forget(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await open();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const marks = chunk.map(() => '?').join(',');
    await db.runAsync(`DELETE FROM uploaded WHERE asset_id IN (${marks})`, chunk);
  }
}

export async function clearLedger(): Promise<void> {
  const db = await open();
  await db.execAsync('DELETE FROM uploaded;');
}
