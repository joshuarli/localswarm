export interface AdmissionLimiter {
  acquire: () => Promise<() => void>;
}

export interface AutoAdmissionOptions {
  maxConcurrency: number;
  fallbackMaxConcurrency: number;
  freeMemoryFloorPercent: number;
  freeMemoryPercent: () => Promise<number | undefined>;
  settleMs: number;
}

export function createAdmissionLimiter(limit: number): AdmissionLimiter {
  let available = limit;
  const waiters: Array<() => void> = [];
  return {
    acquire: async () => {
      if (available > 0) {
        available -= 1;
      } else {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = waiters.shift();
        if (next) next();
        else available += 1;
      };
    },
  };
}

/**
 * Admit sessions while the host has memory headroom, with a conservative
 * concurrency fallback when the host probe is unavailable.
 */
export function createAutoAdmissionLimiter(
  options: AutoAdmissionOptions,
): AdmissionLimiter {
  let active = 0;
  let lastAdmissionAt = performance.now() - options.settleMs;
  const waiters: Array<() => void> = [];
  let pumping = false;

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (waiters.length > 0 && active < options.maxConcurrency) {
        let freePercent: number | undefined;
        try {
          freePercent = await options.freeMemoryPercent();
        } catch {
          freePercent = undefined;
        }
        const atMemoryLimit = freePercent === undefined
          ? active >=
            Math.min(options.maxConcurrency, options.fallbackMaxConcurrency)
          : freePercent < options.freeMemoryFloorPercent;
        if (atMemoryLimit) {
          await new Promise((resolve) => setTimeout(resolve, options.settleMs));
          continue;
        }

        const waitMs = Math.max(
          0,
          options.settleMs - (performance.now() - lastAdmissionAt),
        );
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        const resolve = waiters.shift();
        if (!resolve) break;
        active += 1;
        lastAdmissionAt = performance.now();
        resolve();
      }
    } finally {
      pumping = false;
      if (waiters.length > 0 && active < options.maxConcurrency) void pump();
    }
  };

  return {
    acquire: async () => {
      const ticket = new Promise<void>((resolve) => waiters.push(resolve));
      void pump();
      await ticket;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
        void pump();
      };
    },
  };
}
