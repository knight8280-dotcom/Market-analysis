import { COPY } from "./copy";

/**
 * Visible "SAMPLE DATA" banner (spec rule 6, §6 states). Rendered in every non-production
 * environment, and in any environment whose data includes synthetic records. Production with
 * only licensed data renders nothing.
 */
export function SampleDataBanner(props: { appEnv: string; hasSyntheticData?: boolean }) {
  if (props.appEnv === "production" && !props.hasSyntheticData) return null;
  return (
    <div
      role="note"
      aria-label="Sample data notice"
      style={{
        background: "#7a4b00",
        color: "#ffffff",
        padding: "8px 16px",
        fontWeight: 700,
        letterSpacing: "0.02em",
      }}
    >
      {COPY.sampleDataBanner}
    </div>
  );
}
