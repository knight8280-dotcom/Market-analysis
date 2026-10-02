"use client";

import { formatDateTimeET } from "@market/ui";
import { WifiOff } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * Says so when this device goes offline (spec §6), with the time the page on screen was loaded:
 * what is shown stays, but nothing on it updates until the connection is back.
 */
export function ConnectionStatus() {
  // A new page is a new load: remount to take its time.
  return <Status key={usePathname()} />;
}

function Status() {
  const [loadedAt] = useState(() => new Date());
  useEffect(() => {
    // Lets the service worker's offline page say when a page last loaded here (ADR-037).
    navigator.serviceWorker?.controller?.postMessage({ type: "page-shown" });
  }, []);
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  // The live region is always present so that going offline is announced; it stays in view
  // while the page scrolls.
  return (
    <div role="status" aria-label="Connection" className="sticky top-0 z-30">
      {online ? null : (
        <p className="flex items-center gap-2 bg-banner-stale px-4 py-2 text-sm text-white">
          <WifiOff aria-hidden className="size-4 shrink-0" />
          You&apos;re offline. This page was loaded {formatDateTimeET(loadedAt)} and won&apos;t
          update until the connection is back.
        </p>
      )}
    </div>
  );
}
