import { MAX_FILE_SIZE, VERIFY_WORKER_POOL_MAX } from "../env.ts";
import { onShutdown } from "../helpers/shutdown.ts";

export type VerificationResult =
  | { ok: true; actualSha256: string; size: number }
  | { ok: false; reason: string; actualSha256?: string; size?: number };

type WorkerVerificationResult = VerificationResult & { id: string };

type VerificationTask = {
  id: string;
  sha256: string;
  stream: ReadableStream<Uint8Array>;
  resolve: (result: VerificationResult) => void;
  reject: (error: unknown) => void;
};

type VerifierWorkerHandle = {
  worker: Worker;
  currentTask?: VerificationTask;
};

const verifierWorkerURL =
  new URL("../workers/blob-verifier.ts", import.meta.url).href;
const verifierWorkers = new Set<VerifierWorkerHandle>();
const idleVerifierWorkers: VerifierWorkerHandle[] = [];
const verificationQueue: VerificationTask[] = [];
let verificationTaskId = 0;

function getNextVerificationTaskId() {
  verificationTaskId += 1;
  return `verify-${verificationTaskId}`;
}

function dispatchVerificationTask(
  handle: VerifierWorkerHandle,
  task: VerificationTask,
) {
  handle.currentTask = task;
  handle.worker.postMessage(
    {
      id: task.id,
      sha256: task.sha256,
      stream: task.stream,
      maxFileSize: MAX_FILE_SIZE,
    },
    [task.stream],
  );
}

function maybeRunNextVerificationTask(handle: VerifierWorkerHandle) {
  const task = verificationQueue.shift();
  if (!task) {
    handle.currentTask = undefined;
    idleVerifierWorkers.push(handle);
    return;
  }

  dispatchVerificationTask(handle, task);
}

function removeVerifierWorker(handle: VerifierWorkerHandle) {
  verifierWorkers.delete(handle);
  const index = idleVerifierWorkers.indexOf(handle);
  if (index !== -1) idleVerifierWorkers.splice(index, 1);
}

function createVerifierWorker(): VerifierWorkerHandle {
  const worker = new Worker(verifierWorkerURL, { type: "module" });
  const handle: VerifierWorkerHandle = { worker };

  worker.onmessage = (event: MessageEvent<WorkerVerificationResult>) => {
    const task = handle.currentTask;
    if (!task || task.id !== event.data.id) return;

    const { id: _id, ...result } = event.data;
    task.resolve(result);
    maybeRunNextVerificationTask(handle);
  };

  worker.onerror = (event) => {
    const task = handle.currentTask;
    removeVerifierWorker(handle);
    worker.terminate();

    if (task) task.reject(event.error ?? new Error(event.message));

    const queuedTask = verificationQueue.shift();
    if (queuedTask) {
      void verifyStreamInWorker(queuedTask.sha256, queuedTask.stream)
        .then(queuedTask.resolve)
        .catch(queuedTask.reject);
    }
  };

  verifierWorkers.add(handle);
  return handle;
}

export function verifyStreamInWorker(
  sha256: string,
  stream: ReadableStream<Uint8Array>,
): Promise<VerificationResult> {
  return new Promise((resolve, reject) => {
    const task: VerificationTask = {
      id: getNextVerificationTaskId(),
      sha256,
      stream,
      resolve,
      reject,
    };

    const idle = idleVerifierWorkers.pop();
    if (idle) {
      dispatchVerificationTask(idle, task);
      return;
    }

    if (verifierWorkers.size < VERIFY_WORKER_POOL_MAX) {
      const worker = createVerifierWorker();
      dispatchVerificationTask(worker, task);
      return;
    }

    verificationQueue.push(task);
  });
}

export function getBlobVerifierPoolStats() {
  return {
    activeWorkers: verifierWorkers.size - idleVerifierWorkers.length,
    idleWorkers: idleVerifierWorkers.length,
    maxWorkers: VERIFY_WORKER_POOL_MAX,
    queuedTasks: verificationQueue.length,
  };
}

onShutdown(async () => {
  while (idleVerifierWorkers.length > 0) idleVerifierWorkers.pop();
  while (verificationQueue.length > 0) {
    const task = verificationQueue.shift();
    task?.reject(new Error("Verifier pool shutdown"));
  }

  for (const handle of verifierWorkers) {
    handle.worker.terminate();
  }
  verifierWorkers.clear();
});
