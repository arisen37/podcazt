/** A bounded upload window. A failed item retries without resending acknowledged items. */
export async function selectiveRepeat<T>(items: T[], send: (item: T) => Promise<void>, options: {
  windowSize?: number; attempts?: number; wait?: (ms: number) => Promise<void>;
} = {}) {
  const windowSize = options.windowSize ?? 3;
  const attempts = options.attempts ?? 5;
  if (!Number.isInteger(windowSize) || windowSize < 1 || !Number.isInteger(attempts) || attempts < 1) {
    throw new Error("Invalid retry window");
  }
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let cursor = 0;
  let failure: unknown;
  let failed = false;
  const worker = async () => {
    while (!failed && cursor < items.length) {
      const item = items[cursor++];
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          await send(item);
          break;
        } catch (error) {
          if (attempt === attempts - 1) { failure = error; failed = true; return; }
          await wait(Math.min(1000 * 2 ** attempt, 16000));
          if (failed) return;
        }
      }
    }
  };
  // Wait for every in-flight worker before returning a failure or allowing Retry.
  await Promise.all(Array.from({ length: Math.min(windowSize, items.length) }, worker));
  if (failed) throw failure;
}
