import type {
  BackgroundGenerationRequest,
  BackgroundGenerationResponse,
} from "./generationWorker.ts";

export interface BackgroundGenerationTask<T> {
  promise: Promise<T>;
  cancel(): void;
}

type RequestWithoutId = BackgroundGenerationRequest extends infer T
  ? T extends { id: string } ? Omit<T, "id"> : never
  : never;

export function startBackgroundGeneration<T>(
  request: RequestWithoutId,
  onProgress: (percentage: number, description: string) => void,
): BackgroundGenerationTask<T> {
  const id = `generation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const worker = new Worker(new URL("./generationWorker.ts", import.meta.url), { type: "module" });
  let settled = false;
  let rejectTask: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    rejectTask = reject;
    worker.onmessage = (event: MessageEvent<BackgroundGenerationResponse>) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === "progress") {
        onProgress(message.percentage, message.description);
        return;
      }
      settled = true;
      worker.terminate();
      if (message.type === "error") reject(new Error(message.message));
      else resolve(message.payload as T);
    };
    worker.onerror = (event) => {
      settled = true;
      worker.terminate();
      reject(new Error(event.message || "Background generator worker failed."));
    };
    worker.postMessage({ ...request, id });
  });
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectTask?.(new DOMException("Generation cancelled.", "AbortError"));
    },
  };
}
