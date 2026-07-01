import Dexie, { type EntityTable } from 'dexie';
import type { ArtifactFile, ArtifactRecord, ArtifactView } from './types';

const STORAGE_KEY = 'deepseek_pp_artifacts';
const MAX_ARTIFACTS = 50;
const DB_NAME = 'DeepSeekPPArtifacts';

const db = new Dexie(DB_NAME) as Dexie & {
  artifacts: EntityTable<ArtifactRecord, 'id'>;
};

db.version(1).stores({
  artifacts: 'id, createdAt',
});

let legacyMigrationPromise: Promise<void> | null = null;

export async function saveArtifact(input: {
  kind: ArtifactRecord['kind'];
  filename: string;
  mimeType: string;
  content: string;
  files?: ArtifactFile[];
  view?: ArtifactView;
}): Promise<ArtifactRecord> {
  const record = buildArtifactRecord(input);

  if (shouldUseIndexedDbArtifacts()) {
    await ensureLegacyArtifactsMigrated();
    try {
      await db.artifacts.put(record);
      await pruneArtifactDb();
      return record;
    } catch (error) {
      console.warn('[DeepSeek++] artifact IndexedDB write failed, falling back to storage.local', error);
    }
  }

  const records = await getLegacyArtifacts();
  await setLegacyArtifacts([record, ...records].slice(0, MAX_ARTIFACTS));
  return record;
}

export async function getArtifact(id: string): Promise<ArtifactRecord | null> {
  if (shouldUseIndexedDbArtifacts()) {
    await ensureLegacyArtifactsMigrated();
    try {
      const record = await db.artifacts.get(id);
      if (record) return record;
    } catch (error) {
      console.warn('[DeepSeek++] artifact IndexedDB read failed, falling back to storage.local', error);
    }
  }

  return (await getLegacyArtifacts()).find((artifact) => artifact.id === id) ?? null;
}

export async function getArtifacts(): Promise<ArtifactRecord[]> {
  if (shouldUseIndexedDbArtifacts()) {
    await ensureLegacyArtifactsMigrated();
    try {
      return await db.artifacts.orderBy('createdAt').reverse().limit(MAX_ARTIFACTS).toArray();
    } catch (error) {
      console.warn('[DeepSeek++] artifact IndexedDB list failed, falling back to storage.local', error);
    }
  }

  return getLegacyArtifacts();
}

function buildArtifactRecord(input: {
  kind: ArtifactRecord['kind'];
  filename: string;
  mimeType: string;
  content: string;
  files?: ArtifactFile[];
  view?: ArtifactView;
}): ArtifactRecord {
  return {
    id: crypto.randomUUID(),
    kind: input.kind,
    filename: input.filename,
    mimeType: input.mimeType,
    content: input.content,
    sizeBytes: new TextEncoder().encode(input.content).length,
    createdAt: Date.now(),
    files: input.files,
    view: input.view,
  };
}

function shouldUseIndexedDbArtifacts(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

async function ensureLegacyArtifactsMigrated(): Promise<void> {
  if (!shouldUseIndexedDbArtifacts()) return;
  if (!legacyMigrationPromise) {
    legacyMigrationPromise = migrateLegacyArtifacts().catch((error) => {
      console.warn('[DeepSeek++] artifact legacy migration skipped', error);
    });
  }
  await legacyMigrationPromise;
}

async function migrateLegacyArtifacts(): Promise<void> {
  const legacy = await getLegacyArtifacts();
  if (legacy.length === 0) {
    await clearLegacyArtifacts();
    return;
  }

  await db.transaction('rw', db.artifacts, async () => {
    await db.artifacts.bulkPut(legacy);
    await pruneArtifactDb();
  });
  await clearLegacyArtifacts();
}

async function pruneArtifactDb(): Promise<void> {
  const staleIds = await db.artifacts
    .orderBy('createdAt')
    .reverse()
    .offset(MAX_ARTIFACTS)
    .primaryKeys() as string[];
  if (staleIds.length === 0) return;
  await db.artifacts.bulkDelete(staleIds);
}

async function getLegacyArtifacts(): Promise<ArtifactRecord[]> {
  const storage = getChromeLocalStorage();
  if (!storage) return [];
  const data = await storage.get(STORAGE_KEY) as Record<string, unknown>;
  const value = data[STORAGE_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter(isArtifactRecord);
}

async function setLegacyArtifacts(records: ArtifactRecord[]): Promise<void> {
  const storage = getChromeLocalStorage();
  if (!storage) return;
  await storage.set({ [STORAGE_KEY]: records });
}

async function clearLegacyArtifacts(): Promise<void> {
  const storage = getChromeLocalStorage();
  if (!storage || typeof storage.remove !== 'function') return;
  await storage.remove(STORAGE_KEY);
}

function getChromeLocalStorage(): chrome.storage.LocalStorageArea | null {
  try {
    const storage = chrome.storage?.local;
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') return null;
    return storage;
  } catch {
    return null;
  }
}

function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as ArtifactRecord;
  return typeof record.id === 'string' &&
    (record.kind === 'file' || record.kind === 'bundle') &&
    typeof record.filename === 'string' &&
    typeof record.mimeType === 'string' &&
    typeof record.content === 'string' &&
    typeof record.sizeBytes === 'number' &&
    typeof record.createdAt === 'number';
}
