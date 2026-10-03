import { FEATURE_FLAGS, FLAG_KEYS } from "@market/config";
import { Badge, Button, Card, CardContent, CardHeader, formatDateTimeET, Td, Th } from "@market/ui";
import type { Metadata } from "next";
import { PushSettings } from "../../../components/push-settings";
import { pushServiceName } from "../../../lib/push-subscription";
import { requireOwner } from "../../../server/auth/owner";
import { enabledFlags, flagOverrides } from "../../../server/flags";
import { pushConfig, pushDevices } from "../../../server/push";
import { resetFlag, setFlag } from "./actions";

export const metadata: Metadata = { title: "Settings" };

/** Settings (Phase 2 steps A1 and J2): push notifications on your devices; features on or off. */
export default async function SettingsPage() {
  await requireOwner();
  const [flags, overrides] = await Promise.all([enabledFlags(), flagOverrides()]);
  const push = flags.push ? pushConfig() : null;
  const devices = push ? await pushDevices() : [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          New features ship behind a switch. Turning one off hides its pages and menu entry; its
          saved data stays.
        </p>
      </div>
      <Card id="push" aria-labelledby="push-title">
        <CardHeader
          title={<span id="push-title">Push notifications</span>}
          description="Alerts as notifications on this computer and your phone. Each alert chooses email, push or both."
        />
        <CardContent>
          {!flags.push ? (
            <p className="text-sm text-muted-foreground">
              Push notifications are switched off (Features, below).
            </p>
          ) : !push ? (
            <p className="text-sm text-muted-foreground">
              Not set up yet: run <code>pnpm push:keys</code>, add its two lines and{" "}
              <code>WEB_PUSH_CONTACT</code> to <code>.env</code>, then restart the app and the
              worker (Runbook, &quot;Push notifications&quot;).
            </p>
          ) : (
            <PushSettings
              publicKey={push.publicKey}
              devices={devices.map((d) => ({
                id: d.id,
                device: d.device,
                service: pushServiceName(d.endpoint),
                createdAt: d.createdAt.toISOString(),
                lastSentAt: d.lastSentAt?.toISOString() ?? null,
                lastError: d.lastError,
              }))}
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Features" />
        <CardContent>
          <div tabIndex={0} role="region" aria-label="Features" className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <Th>Feature</Th>
                  <Th>State</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {FLAG_KEYS.map((key) => {
                  const def = FEATURE_FLAGS[key];
                  const on = flags[key];
                  const override = overrides.get(key);
                  return (
                    <tr key={key} data-testid={`flag-${key}`} data-enabled={String(on)}>
                      <Td>
                        <span className="font-medium">{def.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {def.description}
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap">
                        <Badge tone={on ? "info" : "neutral"}>{on ? "On" : "Off"}</Badge>
                        <span className="block text-xs text-muted-foreground">
                          {override
                            ? `Changed ${formatDateTimeET(override.updatedAt)}; default ${def.default ? "on" : "off"}`
                            : "Default"}
                        </span>
                      </Td>
                      <Td>
                        <span className="flex justify-end gap-1">
                          <form action={setFlag}>
                            <input type="hidden" name="key" value={key} />
                            <input type="hidden" name="enabled" value={String(!on)} />
                            <Button type="submit" variant="secondary" size="sm">
                              {on ? `Turn off ${def.label}` : `Turn on ${def.label}`}
                            </Button>
                          </form>
                          {override ? (
                            <form action={resetFlag}>
                              <input type="hidden" name="key" value={key} />
                              <Button type="submit" variant="ghost" size="sm">
                                Use default
                              </Button>
                            </form>
                          ) : null}
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
