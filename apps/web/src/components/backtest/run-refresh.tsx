"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Refreshes a run's page every two seconds until the worker has finished with it. */
export function RunRefresh({ status }: { status: string }) {
  const router = useRouter();
  useEffect(() => {
    if (status !== "queued" && status !== "running") return;
    const timer = setInterval(() => router.refresh(), 2_000);
    return () => clearInterval(timer);
  }, [status, router]);
  return null;
}
