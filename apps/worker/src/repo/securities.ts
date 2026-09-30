import type { IsoDate } from "@market/calendar";
import { sql, type Database } from "@market/db";
import type { ProviderId, SecurityRecord } from "@market/market-data";

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
      await trx
        .updateTable("market.securities")
        .set({ ...fields, updated_at: record.fetched_at })
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
