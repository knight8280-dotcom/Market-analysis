import { ImageResponse } from "next/og";
import { appIcon } from "../lib/app-icon";
import { ICON_SIZES } from "../lib/pwa";

/** App icons for the browser tab and the web app manifest, drawn at build time (ADR-037). */
export function generateImageMetadata() {
  return ICON_SIZES.map((size) => ({
    id: String(size),
    size: { width: size, height: size },
    contentType: "image/png",
  }));
}

export default async function Icon({ id }: { id: Promise<string> }) {
  const size = Number(await id);
  return new ImageResponse(appIcon(size), { width: size, height: size });
}
