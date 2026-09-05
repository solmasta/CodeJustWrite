// Persists the user's chosen "save conversations here" folder across sessions, so exporting
// after the first pick is a single tap instead of a file-save dialog every time. A
// FileSystemDirectoryHandle isn't JSON-serializable (localStorage can't hold it) but IS
// structured-cloneable, which IndexedDB natively supports — so that's the only browser storage
// that can actually hold onto it. Only available on browsers implementing the File System Access
// API (Chromium-based; not Safari/iOS) — callers should feature-detect via `supportsExportFolder`
// before offering this in the UI at all.

const DB_NAME = "cjw-export";
const STORE = "handles";
const KEY = "exportDir";

export const supportsExportFolder = typeof window !== "undefined" && "showDirectoryPicker" in window;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveExportDirHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadExportDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearExportDirHandle(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** A stored handle's permission grant isn't guaranteed to persist indefinitely — checks the
 *  current grant first, and only prompts (a small permission bar, not a full file picker) if it's
 *  actually needed. Must be called from a user-gesture call stack (e.g. directly from a click
 *  handler) or the browser will silently deny the prompt. */
export async function hasReadWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const opts = { mode: "readwrite" as const };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  try {
    return (await handle.requestPermission(opts)) === "granted";
  } catch {
    return false;
  }
}
