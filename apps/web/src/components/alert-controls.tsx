import { Badge, Button, formatDateTimeET } from "@market/ui";
import { deleteAlert, setAlertActive, snoozeAlert } from "../app/(app)/alerts/actions";
import { SNOOZE_CHOICES } from "../lib/alert-form";

const select =
  "min-h-8 rounded-md border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";

/**
 * Snooze, resume, pause and delete for one alert (spec §5.14: from the notification itself).
 * `name` ("TEST_DIV alert: Closes above $100.00") makes every control's label unique on a page.
 */
export function AlertControls({
  alert,
  name,
  returnTo,
}: {
  alert: { id: string; active: boolean; snoozedUntil: Date | null };
  name: string;
  returnTo: string;
}) {
  const ids = (
    <>
      <input type="hidden" name="id" value={alert.id} />
      <input type="hidden" name="returnTo" value={returnTo} />
    </>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!alert.active ? <Badge tone="neutral">Paused</Badge> : null}
      {alert.active && alert.snoozedUntil ? (
        <>
          <Badge tone="warning">Snoozed until {formatDateTimeET(alert.snoozedUntil)}</Badge>
          <form action={snoozeAlert}>
            {ids}
            <input type="hidden" name="hours" value="0" />
            <Button type="submit" variant="ghost" size="sm" aria-label={`End the snooze: ${name}`}>
              End snooze
            </Button>
          </form>
        </>
      ) : alert.active ? (
        <form action={snoozeAlert} className="flex items-center gap-1">
          {ids}
          <select
            name="hours"
            defaultValue={String(SNOOZE_CHOICES[0]!.hours)}
            aria-label={`Snooze length for ${name}`}
            className={select}
          >
            {SNOOZE_CHOICES.map((c) => (
              <option key={c.hours} value={c.hours}>
                {c.label}
              </option>
            ))}
          </select>
          <Button type="submit" variant="secondary" size="sm" aria-label={`Snooze ${name}`}>
            Snooze
          </Button>
        </form>
      ) : null}
      <form action={setAlertActive}>
        {ids}
        <input type="hidden" name="active" value={String(!alert.active)} />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          aria-label={`${alert.active ? "Pause" : "Resume"} ${name}`}
        >
          {alert.active ? "Pause" : "Resume"}
        </Button>
      </form>
      <form action={deleteAlert}>
        {ids}
        <Button type="submit" variant="ghost" size="sm" aria-label={`Delete ${name}`}>
          Delete alert
        </Button>
      </form>
    </div>
  );
}
