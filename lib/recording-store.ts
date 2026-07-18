const DATABASE_NAME = "podcazt-recordings";
const DATABASE_VERSION = 1;
const CHUNK_STORE = "chunks";

type StoredChunk = {
  recordingId: string;
  chunkIndex: number;
  blob: Blob;
  createdAt: number;
};

function openRecordingDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        const store = database.createObjectStore(CHUNK_STORE, {
          keyPath: ["recordingId", "chunkIndex"]
        });
        store.createIndex("byRecording", "recordingId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local recording storage"));
  });
}

function waitForTransaction(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Local recording transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Local recording transaction was aborted"));
  });
}

function createWriteTransaction(database: IDBDatabase) {
  try {
    return database.transaction(CHUNK_STORE, "readwrite", { durability: "strict" });
  } catch {
    return database.transaction(CHUNK_STORE, "readwrite");
  }
}

export async function saveRecordingChunk(recordingId: string, chunkIndex: number, blob: Blob) {
  const database = await openRecordingDatabase();
  try {
    const transaction = createWriteTransaction(database);
    transaction.objectStore(CHUNK_STORE).put({
      recordingId,
      chunkIndex,
      blob,
      createdAt: Date.now()
    } satisfies StoredChunk);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export async function getRecordingChunks(recordingId: string) {
  const database = await openRecordingDatabase();
  try {
    const transaction = database.transaction(CHUNK_STORE, "readonly");
    const completion = waitForTransaction(transaction);
    const request = transaction.objectStore(CHUNK_STORE).index("byRecording").getAll(recordingId);
    const chunks = await new Promise<StoredChunk[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as StoredChunk[]);
      request.onerror = () => reject(request.error ?? new Error("Could not read local recording chunks"));
    });
    await completion;
    return chunks.sort((left, right) => left.chunkIndex - right.chunkIndex);
  } finally {
    database.close();
  }
}

export async function clearRecordingChunks(recordingId: string) {
  const database = await openRecordingDatabase();
  try {
    const transaction = createWriteTransaction(database);
    const completion = waitForTransaction(transaction);
    const store = transaction.objectStore(CHUNK_STORE);
    const keysRequest = store.index("byRecording").getAllKeys(recordingId);
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      keysRequest.onsuccess = () => resolve(keysRequest.result);
      keysRequest.onerror = () => reject(keysRequest.error ?? new Error("Could not find local recording chunks"));
    });
    keys.forEach((key) => store.delete(key));
    await completion;
  } finally {
    database.close();
  }
}
