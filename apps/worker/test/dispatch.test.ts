import { describe, expect, it } from "vitest";
import { InlineDispatcher } from "../src/dispatch";
import { jobId } from "../src/queues";

describe("InlineDispatcher", () => {
  it("runs each job id once, including jobs dispatched while draining", async () => {
    const d = new InlineDispatcher();
    const ran: string[] = [];
    await d.dispatch({ name: "ingest-eod", data: {}, jobId: "a" });
    await d.dispatch({ name: "ingest-eod", data: {}, jobId: "a" });
    const result = await d.drain(async (job) => {
      ran.push(job.jobId);
      if (job.jobId === "a") await d.dispatch({ name: "ingest-eod", data: {}, jobId: "b" });
    });
    expect(ran).toEqual(["a", "b"]);
    expect(result).toEqual({ ran: 2, failed: 0 });
  });

  it("reports failures and keeps going", async () => {
    const d = new InlineDispatcher();
    await d.dispatch({ name: "ingest-eod", data: {}, jobId: "x" });
    await d.dispatch({ name: "ingest-eod", data: {}, jobId: "y" });
    const errors: string[] = [];
    const result = await d.drain(
      (job) => (job.jobId === "x" ? Promise.reject(new Error("boom")) : Promise.resolve()),
      (job) => errors.push(job.jobId),
    );
    expect(result).toEqual({ ran: 1, failed: 1 });
    expect(errors).toEqual(["x"]);
  });
});

describe("jobId", () => {
  it("joins parts with / and refuses colons", () => {
    expect(jobId("ingest-eod", "2026-09-29", "TEST_A")).toBe("ingest-eod/2026-09-29/TEST_A");
    expect(() => jobId("ingest-eod", "a:b")).toThrow();
  });
});
