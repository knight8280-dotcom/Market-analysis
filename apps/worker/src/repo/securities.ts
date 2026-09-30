import type { IsoDate } from "@market/calendar";
import { sql, type Database } from "@market/db";
import { sectorForSic, type ProviderId, type SecurityRecord } from "@market/market-data";
import type { EdgarEntity } from "@market/market-data/adapters/sec-edgar";

const OPEN_START = "1900-01-01";

/**
 * Upserts a vendor security record into the securities master (spec §3.7). The security is
 * found by the vendor's permanent id when it has one, otherwise by the vendor symbol valid at
 * the listing date, so a reused ticker becomes a new security rather than overwriting the old
 * one. Delisted securities are updated, never deleted.
 */
export async function upsertSecurityRecord(
  db: Database,
  record: SecurityRecord,
): Promise<{ securityId: string; created: boolean }> {
  return db.transaction().execute(async (trx) => {
    const listedOrOpen = record.listed_at ?? OPEN_START;
    let existing: { security_id: string } | undefined;
    if (record.source_security_id) {
      existing = await trx
        .selectFrom("market.provider_symbols")
        .select("security_id")
        .where("source", "=", record.source)
        .where("source_security_id", "=", record.source_security_id)
        .executeTakeFirst();
    } else if (record.source_symbol) {
      existing = await trx
        .selectFrom("market.provider_symbols")
        .select("security_id")
        .where("source", "=", record.source)
        .where("source_symbol", "=", record.source_symbol)
        .where(sql<boolean>`daterange(valid_from, valid_to, '[)') @> ${listedOrOpen}::date`)
        .executeTakeFirst();
    }

    const fields = {
      ticker: record.ticker,
      name: record.name,
      asset_class: record.asset_class,
      exchange_mic: record.exchange_mic,
      cik: record.cik,
      figi: record.figi,
      sector: record.sector,
      industry: record.industry,
      currency: record.currency,
      is_active: record.delisted_at === null,
      listed_at: record.listed_at,
      delisted_at: record.delisted_at,
    };

    let securityId: string;
    let created = false;
    if (existing) {
      securityId = existing.security_id;
      // Enrichment from other sources (CIK and SIC sector from EDGAR) is kept when this vendor
      // does not report it.
      await trx
        .updateTable("market.securities")
        .set({
          ...fields,
          cik: sql<string | null>`coalesce(${record.cik}, cik)`,
          figi: sql<string | null>`coalesce(${record.figi}, figi)`,
          sector: sql<string | null>`coalesce(${record.sector}, sector)`,
          industry: sql<string | null>`coalesce(${record.industry}, industry)`,
          updated_at: record.fetched_at,
        })
        .where("security_id", "=", securityId)
        .execute();
    } else {
      const row = await trx
        .insertInto("market.securities")
        .values(fields)
        .returning("security_id")
        .executeTakeFirstOrThrow();
      securityId = row.security_id;
      created = true;
    }

    const history = record.symbol_history.length
      ? record.symbol_history
      : [{ ticker: record.ticker, valid_from: listedOrOpen, valid_to: record.delisted_at }];
    for (const period of history) {
      await trx
        .insertInto("market.security_symbol_history")
        .values({ security_id: securityId, ...period })
        .onConflict((oc) =>
          oc
            .columns(["security_id", "valid_from"])
            .doUpdateSet({ ticker: period.ticker, valid_to: period.valid_to }),
        )
        .execute();
    }

    if (record.source_symbol) {
      await trx
        .insertInto("market.provider_symbols")
        .values({
          security_id: securityId,
          source: record.source,
          source_symbol: record.source_symbol,
          source_security_id: record.source_security_id,
          valid_from: listedOrOpen,
          valid_to: record.delisted_at,
        })
        .onConflict((oc) =>
          oc.columns(["source", "source_symbol", "valid_from"]).doUpdateSet({
            valid_to: record.delisted_at,
            source_security_id: record.source_security_id,
          }),
        )
        .execute();
    }
    return { securityId, created };
  });
}

/**
 * Equities that could carry an SEC CIK but do not yet. Only securities with a real vendor
 * mapping qualify: synthetic securities never get real identifiers, so sample data can never be
 * joined to real filings.
 */
export async function securitiesMissingCik(
  db: Database,
): Promise<{ security_id: string; ticker: string }[]> {
  return db
    .selectFrom("market.securities as s")
    .select(["s.security_id", "s.ticker"])
    .where("s.cik", "is", null)
    .where("s.asset_class", "=", "equity")
    .where("s.is_active", "=", true)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("market.provider_symbols as ps")
          .select(sql`1`.as("one"))
          .whereRef("ps.security_id", "=", "s.security_id")
          .where("ps.source", "<>", "synthetic"),
      ),
    )
    .orderBy("s.ticker")
    .execute();
}

export async function setCik(db: Database, securityId: string, cik: string, at: Date) {
  await db
    .updateTable("market.securities")
    .set({ cik, updated_at: at })
    .where("security_id", "=", securityId)
    .where("cik", "is", null)
    .execute();
}

/**
 * Sets the SIC code, industry (SIC description) and sector (mapped from SIC, ADR-016) on every
 * security with this CIK. Returns how many rows changed.
 */
export async function applyEdgarEntity(
  db: Database,
  entity: Pick<EdgarEntity, "cik" | "sicCode" | "sicDescription">,
  at: Date,
): Promise<number> {
  if (!entity.sicCode) return 0;
  const sector = sectorForSic(entity.sicCode);
  const result = await sql`
    update market.securities
    set sic_code = ${entity.sicCode},
        industry = coalesce(${entity.sicDescription}::text, industry),
        sector = coalesce(${sector}::text, sector),
        updated_at = ${at}
    where cik = ${entity.cik}
      and (sic_code is distinct from ${entity.sicCode}
        or industry is distinct from coalesce(${entity.sicDescription}::text, industry)
        or sector is distinct from coalesce(${sector}::text, sector))
  `.execute(db);
  return Number(result.numAffectedRows ?? 0);
}

export interface SymbolMapping {
  security_id: string;
  valid_from: IsoDate;
  valid_to: IsoDate | null;
}

/** Securities a vendor symbol has pointed at, with validity ranges. */
export async function mappingsFor(
  db: Database,
  source: ProviderId,
  sourceSymbol: string,
): Promise<SymbolMapping[]> {
  return db
    .selectFrom("market.provider_symbols")
    .select(["security_id", "valid_from", "valid_to"])
    .where("source", "=", source)
    .where("source_symbol", "=", sourceSymbol)
    .orderBy("valid_from")
    .execute();
}

export function securityOn(mappings: readonly SymbolMapping[], date: IsoDate): string | null {
  const m = mappings.find(
    (x) => x.valid_from <= date && (x.valid_to === null || date < x.valid_to),
  );
  return m ? m.security_id : null;
}

/**
 * Vendor symbols to fetch for a trading date: every mapping of `source` whose security was
 * listed on that date. Mappings are looked up for the source actually serving the dataset.
 */
export async function symbolsListedOn(
  db: Database,
  source: ProviderId,
  date: IsoDate,
): Promise<string[]> {
  const rows = await db
    .selectFrom("market.provider_symbols as ps")
    .innerJoin("market.securities as s", "s.security_id", "ps.security_id")
    .select("ps.source_symbol")
    .distinct()
    .where("ps.source", "=", source)
    .where(sql<boolean>`daterange(ps.valid_from, ps.valid_to, '[)') @> ${date}::date`)
    .where((eb) => eb.or([eb("s.listed_at", "is", null), eb("s.listed_at", "<=", date)]))
    .where((eb) => eb.or([eb("s.delisted_at", "is", null), eb("s.delisted_at", ">", date)]))
    .orderBy("ps.source_symbol")
    .execute();
  return rows.map((r) => r.source_symbol);
}
