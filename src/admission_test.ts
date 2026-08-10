import {
  createAutoAdmissionLimiter,
} from "./admission.ts";

Deno.test("auto admission starts pumping after the first waiter queues", async () => {
  const limiter = createAutoAdmissionLimiter({
    maxConcurrency: 2,
    fallbackMaxConcurrency: 2,
    freeMemoryFloorPercent: 20,
    freeMemoryPercent: async () => 100,
    settleMs: 0,
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("auto admission did not admit")), 100)
  );

  const release = await Promise.race([limiter.acquire(), timeout]);
  release();
});
