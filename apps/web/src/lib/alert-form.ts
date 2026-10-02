import { AlertDefinition, type AlertKind, ALERT_KINDS, SNOOZE_HOURS } from "@market/alerts";

/**
 * The new-alert form as data (Phase 1 step I1, Phase 2 step E1): form fields → a validated
 * definition. Plain TypeScript so it is unit-tested; the server action and the form share it.
 */

interface FormLike {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}

/**
 * Filing types offered as checkboxes. Since December 2024 SEC files Schedules 13D and 13G under
 * new EDGAR form names; both old and new names are watched (to verify against recorded EDGAR
 * data when real filings arrive).
 */
export const FORM_CHOICES = [
  { id: "10-K", label: "10-K annual report", forms: ["10-K"] },
  { id: "10-Q", label: "10-Q quarterly report", forms: ["10-Q"] },
  { id: "8-K", label: "8-K current report", forms: ["8-K"] },
  { id: "4", label: "Form 4 insider transaction", forms: ["4"] },
  { id: "13D", label: "13D: holder of 5% or more (active)", forms: ["SC 13D", "SCHEDULE 13D"] },
  { id: "13G", label: "13G: holder of 5% or more (passive)", forms: ["SC 13G", "SCHEDULE 13G"] },
  { id: "DEF 14A", label: "DEF 14A proxy statement", forms: ["DEF 14A"] },
  { id: "S-1", label: "S-1 registration", forms: ["S-1"] },
] as const;

/** What each kind needs, shown when its fields do not validate. */
export const CONDITION_HELP: Record<AlertKind, string> = {
  price_above: "Enter a price above zero.",
  price_below: "Enter a price above zero.",
  pct_move: "Enter a move above 0% and up to 100%.",
  earnings_upcoming: "Enter 1 to 30 days.",
  rsi_below: "RSI levels are above 0 and below 100; the RSI covers 2 to 100 sessions.",
  rsi_above: "RSI levels are above 0 and below 100; the RSI covers 2 to 100 sessions.",
  sma_cross:
    "Averages cover 1 to 400 sessions (1 means the close itself), the fast one fewer than the slow one.",
  volume_spike:
    "The multiple is 1.1 to 100, and the average covers the 5 to 250 sessions before the spike.",
  new_filing:
    "Pick at least one form (20 at most). Type other forms by their EDGAR names, such as 424B2; amendments are covered by the box below them.",
  screen_membership: "Pick one of your saved screens.",
};

const text = (form: FormLike, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};
/** A number as typed: "$1,200", "5%" and " 30 " all read as numbers; blank is NaN. */
const num = (form: FormLike, name: string) => {
  const v = text(form, name).replace(/[$,%×x\s]/gi, "");
  return v === "" ? Number.NaN : Number(v);
};

export function isAlertKind(kind: string): kind is AlertKind {
  return (ALERT_KINDS as readonly string[]).includes(kind);
}

/** The filing forms chosen: the checkboxes plus any typed in "other", uppercased, each once. */
export function chosenForms(form: FormLike): string[] {
  const out: string[] = [];
  for (const v of form.getAll("forms")) {
    const choice = FORM_CHOICES.find((c) => c.id === v);
    if (choice) out.push(...choice.forms);
  }
  for (const v of text(form, "otherForms").split(",")) {
    const f = v.trim().toUpperCase().replace(/\s+/g, " ");
    if (f) out.push(f);
  }
  return [...new Set(out)];
}

/** The definition the form describes, or null when it does not validate. */
export function definitionFrom(form: FormLike): AlertDefinition | null {
  const kind = text(form, "kind");
  if (!isAlertKind(kind)) return null;
  const raw = (() => {
    switch (kind) {
      case "price_above":
      case "price_below":
        return { price: num(form, "price") };
      case "pct_move":
        return { pct: num(form, "pct") / 100, direction: text(form, "direction") || "either" };
      case "earnings_upcoming":
        return { days: num(form, "days") };
      case "rsi_below":
      case "rsi_above":
        return { level: num(form, "level"), period: num(form, "period") };
      case "sma_cross":
        return {
          fast: num(form, "fast"),
          slow: num(form, "slow"),
          direction: text(form, "cross") || "above",
        };
      case "volume_spike":
        return { multiple: num(form, "multiple"), lookback: num(form, "lookback") };
      case "new_filing":
        return { forms: chosenForms(form), amendments: text(form, "amendments") === "on" };
      case "screen_membership":
        return { change: text(form, "change") || "either" };
    }
  })();
  const parsed = AlertDefinition.safeParse({ kind, params: raw });
  return parsed.success ? parsed.data : null;
}

/** Snooze choices: hours, and how the buttons read. */
export const SNOOZE_CHOICES = SNOOZE_HOURS.map((hours) => ({
  hours,
  label: hours === 24 ? "1 day" : hours === 168 ? "1 week" : `${hours / 24} days`,
}));

/** Where an alert action may return to: its own pages only, never an arbitrary URL. */
export function safeReturnPath(raw: string | null | undefined, fallback = "/alerts"): string {
  if (!raw) return fallback;
  return /^\/(alerts(\/\d{1,18})?|notifications)$/.test(raw) ? raw : fallback;
}
