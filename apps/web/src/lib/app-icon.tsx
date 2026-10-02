import { APP_BACKGROUND } from "./pwa";

/**
 * The app icon: three rising bars under a trend line on the dark background, in the theme's
 * primary and "up" colors. The drawing stays inside the central circle that Android's icon masks
 * keep, so the same image serves as the "maskable" icon.
 */
export function appIcon(size: number) {
  const glyph = Math.round(size * 0.6);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: APP_BACKGROUND,
      }}
    >
      <svg width={glyph} height={glyph} viewBox="0 0 60 60">
        <rect x="4" y="36" width="12" height="20" rx="2" fill="#4493f8" />
        <rect x="24" y="26" width="12" height="30" rx="2" fill="#4493f8" />
        <rect x="44" y="14" width="12" height="42" rx="2" fill="#4493f8" />
        <polyline
          points="6,26 26,16 50,4"
          fill="none"
          stroke="#3fb950"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
