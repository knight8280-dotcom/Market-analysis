/**
 * A name for the browser that turned push on, from its user agent: "Chrome on Android",
 * "Safari on iPhone". Only for telling devices apart in Settings; nothing depends on it.
 */
const BROWSERS: [RegExp, string][] = [
  [/\bEdgA?\//, "Edge"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bOPR\//, "Opera"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  // "HeadlessChrome/" too, so no word boundary before "Chrome".
  [/\bCriOS\/|Chrome\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMacintosh\b|\bMac OS X\b/, "Mac"],
  [/\bLinux\b/, "Linux"],
];

export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? "A browser";
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  return system ? `${browser} on ${system}` : browser;
}
