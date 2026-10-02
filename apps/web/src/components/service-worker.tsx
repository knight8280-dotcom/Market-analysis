"use client";

import { useEffect } from "react";
import { SERVICE_WORKER_PATH } from "../lib/pwa";

/**
 * Registers the service worker (ADR-037): the offline page now, push notifications later.
 * Browsers without service workers, or pages not on HTTPS or localhost, simply go without.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register(SERVICE_WORKER_PATH, { scope: "/", updateViaCache: "none" })
      .catch(() => {
        // Not fatal: the app works the same, without the offline page.
      });
  }, []);
  return null;
}
