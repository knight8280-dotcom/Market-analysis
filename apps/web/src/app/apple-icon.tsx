import { ImageResponse } from "next/og";
import { appIcon } from "../lib/app-icon";
import { APPLE_ICON_SIZE } from "../lib/pwa";

export const size = { width: APPLE_ICON_SIZE, height: APPLE_ICON_SIZE };
export const contentType = "image/png";

/** The iPhone and iPad Home Screen icon; iOS rounds the corners itself (ADR-037). */
export default function AppleIcon() {
  return new ImageResponse(appIcon(APPLE_ICON_SIZE), size);
}
