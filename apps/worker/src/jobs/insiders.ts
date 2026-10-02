import { ProviderResponseError } from "@market/market-data";
import { padCik, SecEdgarProvider } from "@market/market-data/adapters/sec-edgar";
import {
  INSIDER_FORMS,
  ownershipXmlFile,
  parseOwnershipDocument,
} from "@market/market-data/adapters/sec-ownership";
import { z } from "zod";
import type { WorkerContext } from "../context";
import { JOBS, jobId } from "../queues";
import { queueAlertEvaluation } from "./alerts";
import { pendingInsiderFilings, recordInsiderError, storeInsiderFiling } from "../repo/insiders";
import { resolveSource, withProviderHealth } from "../routing";

/**
 * Form 4 insider transactions (Phase 2 step H1, spec §5.13). Each Form 4 or 4/A that a filings
 * refresh stores is read from its EDGAR XML; older filings are read by the `insiders` sweep.
 * Bump the parser version when parsing changes, so sweeps read stored filings again.
 */
export const INSIDER_PARSER_VERSION = 1;

/** Filings refreshes read new Form 4s filed this recently; older history is a sweep. */
export const RECENT_INSIDER_DAYS = 30;

const Input = z.object({
  cik: z.string().regex(/^\d{1,10}$/),
  accession_no: z.string().regex(/^\d{10}-\d{2}-\d{6}$/),
});

export async function ingestInsiderFiling(ctx: WorkerContext, raw: unknown) {
  const input = Input.parse(raw);
  const accession_no = input.accession_no;
  const cik = padCik(input.cik);
  const filing = await ctx.db
    .selectFrom("market.filings")
    .select(["form_type", "primary_document", "filed_at", "url"])
    .where("accession_no", "=", accession_no)
    .where("cik", "=", cik)
    .executeTakeFirst();
  if (!filing) throw new Error(`Filing ${accession_no} is not stored for CIK ${cik}`);
  if (!(INSIDER_FORMS as readonly string[]).includes(filing.form_type)) {
    return { accession_no, status: "not_form_4" as const };
  }

  const done = await ctx.db
    .selectFrom("market.insider_filings")
    .select("parser_version")
    .where("accession_no", "=", accession_no)
    .executeTakeFirst();
  if (done && done.parser_version >= INSIDER_PARSER_VERSION) {
    return { accession_no, status: "already_read" as const };
  }

  const fail = async (error: string) => {
    await recordInsiderError(ctx.db, {
      accession: accession_no,
      cik,
      error,
      parserVersion: INSIDER_PARSER_VERSION,
      at: ctx.clock(),
    });
    ctx.log.warn({ accession_no, cik, error }, "Form 4 not readable");
    return { accession_no, status: "unreadable" as const, error };
  };

  const file = ownershipXmlFile(filing.primary_document);
  if (!file)
    return fail(`no XML document (primary document: ${filing.primary_document ?? "none"})`);

  const { route, source, provider } = await resolveSource(ctx, "filings");
  if (!(provider instanceof SecEdgarProvider)) {
    throw new Error(`Form 4 documents come from SEC EDGAR, not ${source}`);
  }
  const xml = await withProviderHealth(ctx, { route, source, dataset: "filings" }, () =>
    provider.getArchiveDocument({ cik, accession: accession_no, file }),
  );
  let parsed;
  try {
    parsed = parseOwnershipDocument(xml, {
      accession_no,
      filed_at: filing.filed_at,
      fetched_at: ctx.clock(),
    });
  } catch (err) {
    // A document the parser refuses will not change on a retry; network errors (above) do retry.
    if (err instanceof ProviderResponseError) return fail(err.message);
    throw err;
  }
  const { stored } = await storeInsiderFiling(ctx.db, parsed, {
    url: filing.url,
    filedAt: filing.filed_at,
    parserVersion: INSIDER_PARSER_VERSION,
  });
  // An open-market purchase is checked against insider-purchase alerts at once (step H4).
  const purchase = parsed.transactions.some(
    (t) => t.code === "P" && !t.derivative && t.acquired_disposed === "A",
  );
  if (stored && purchase && parsed.form_type === "4") {
    const securities = await ctx.db
      .selectFrom("market.securities")
      .select("security_id")
      .where("cik", "=", parsed.issuer_cik)
      .execute();
    await queueAlertEvaluation(ctx, {
      trigger: "insiders",
      runId: accession_no,
      securityIds: securities.map((s) => s.security_id),
      kinds: ["insider_purchase"],
    });
  }
  return {
    accession_no,
    status: stored ? ("read" as const) : ("already_read" as const),
    issuer_cik: parsed.issuer_cik,
    transactions: parsed.transactions.length,
  };
}

/** Queues one job per filing; the job id makes a filing listed under several CIKs run once. */
export async function queueInsiderFilings(
  ctx: WorkerContext,
  filings: readonly { cik: string; accession_no: string }[],
): Promise<number> {
  for (const f of filings) {
    await ctx.dispatch.dispatch({
      name: JOBS.ingestInsider,
      data: { cik: padCik(f.cik), accession_no: f.accession_no },
      jobId: jobId(JOBS.ingestInsider, f.accession_no, `v${INSIDER_PARSER_VERSION}`),
    });
  }
  return filings.length;
}

const SweepInput = z.object({
  days: z.number().int().min(1).max(3650).default(RECENT_INSIDER_DAYS),
  ciks: z.array(z.string().regex(/^\d{1,10}$/)).optional(),
  limit: z.number().int().positive().optional(),
});

/**
 * Queues every stored Form 4 filed in the last `days` that has not been read yet (the daily
 * sweep, and `pnpm worker insiders --days 730` for history).
 */
export async function sweepInsiders(ctx: WorkerContext, raw: unknown) {
  const { days, ciks, limit } = SweepInput.parse(raw ?? {});
  const since = new Date(ctx.clock().getTime() - days * 86_400_000);
  const pending = await pendingInsiderFilings(ctx.db, {
    since,
    parserVersion: INSIDER_PARSER_VERSION,
    ciks: ciks?.map(padCik),
    limit,
  });
  const queued = await queueInsiderFilings(ctx, pending);
  return { since: since.toISOString(), queued };
}
