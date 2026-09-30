"use client";

import { COPY } from "@market/compliance";
import { DataLabel, type SourceInfo } from "@market/compliance/client";
import {
  Button,
  cn,
  formatCompact,
  formatDate,
  formatNumber,
  formatPercent,
  Skeleton,
} from "@market/ui";
import type * as LightweightCharts from "lightweight-charts";
import type { IChartApi, ISeriesApi, MouseEventParams, SeriesType, Time } from "lightweight-charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  alignBenchmark,
  computeIndicators,
  INDICATORS,
  TIMEFRAMES,
  timeframeStart,
  WORKER_THRESHOLD,
  type ChartBars,
  type IndicatorResults,
  type Timeframe,
} from "../../lib/chart/catalog";
import type { WorkerRequest, WorkerResponse } from "../../lib/chart/indicator.worker";

interface ChartData {
  ticker: string;
  currency: string;
  adjusted: boolean;
  source: SourceInfo;
  asOf: string | null;
  fetchedAt: string | null;
  bars: [string, number, number, number, number, number][];
  actions: { date: string; type: string; label: string }[];
  /** Earnings report dates (Finnhub or 8-K Item 2.02). */
  earnings: string[];
  benchmark: { ticker: string; closes: [string, number][] } | null;
}

export interface ChartSettings {
  tf: Timeframe;
  indicators: string[];
  adjusted: boolean;
  type: "candles" | "line";
}

type LC = typeof LightweightCharts;
let libPromise: Promise<LC> | null = null;
/** The chart library loads only when a chart is shown (spec §6: charts lazy-loaded). */
const loadLib = () => (libPromise ??= import("lightweight-charts"));

const PRICE_PANE = 380;
const INDICATOR_PANE = 130;

function toBars(data: ChartData): ChartBars {
  const b: ChartBars = { time: [], open: [], high: [], low: [], close: [], volume: [] };
  for (const [t, o, h, l, c, v] of data.bars) {
    b.time.push(t);
    b.open.push(o);
    b.high.push(h);
    b.low.push(l);
    b.close.push(c);
    b.volume.push(v);
  }
  return b;
}

function cssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = Number.parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Interactive price chart for one security (Phase 1 steps D2–D3): candles or line with volume,
 * split/dividend markers, timeframes ([ and ] step through them), raw or adjusted prices, and
 * indicator overlays and panes. More than WORKER_THRESHOLD indicators compute in a Web Worker.
 * A text summary and a data table give the same information without the canvas.
 */
export function StockChart({ ticker, initial }: { ticker: string; initial: ChartSettings }) {
  const [settings, setSettings] = useState<ChartSettings>(initial);
  const [data, setData] = useState<ChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [results, setResults] = useState<IndicatorResults>({});
  const [themeVersion, setThemeVersion] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);

  const bars = useMemo(() => (data ? toBars(data) : null), [data]);
  const benchmark = useMemo(
    () => (bars && data ? alignBenchmark(bars.time, data.benchmark?.closes ?? null) : null),
    [bars, data],
  );

  // Keep the URL in step with the settings, without a server round trip.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tf", settings.tf);
    url.searchParams.set("ind", settings.indicators.join(","));
    url.searchParams.set("adj", settings.adjusted ? "1" : "0");
    url.searchParams.set("type", settings.type);
    window.history.replaceState(window.history.state, "", url);
  }, [settings]);

  // Data.
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetch(
      `/api/stocks/${encodeURIComponent(ticker)}/series?adjusted=${settings.adjusted ? 1 : 0}`,
      {
        signal: controller.signal,
      },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData((await res.json()) as ChartData);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError("The chart data could not be loaded.");
      });
    return () => controller.abort();
  }, [ticker, settings.adjusted, attempt]);

  // Indicators: inline for a few, in a worker for many.
  useEffect(() => {
    if (!bars) return;
    const ids = settings.indicators;
    if (ids.length <= WORKER_THRESHOLD) {
      setResults(computeIndicators(bars, benchmark, ids));
      return;
    }
    workerRef.current ??= new Worker(
      new URL("../../lib/chart/indicator.worker.ts", import.meta.url),
      { type: "module" },
    );
    const worker = workerRef.current;
    const id = ++requestRef.current;
    const onMessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.id === requestRef.current) setResults(e.data.results);
    };
    worker.addEventListener("message", onMessage);
    const request: WorkerRequest = { id, bars, benchmark, indicators: ids };
    worker.postMessage(request);
    return () => worker.removeEventListener("message", onMessage);
  }, [bars, benchmark, settings.indicators]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  // Re-color when the theme changes.
  useEffect(() => {
    const bump = () => setThemeVersion((v) => v + 1);
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const media = window.matchMedia("(prefers-color-scheme: light)");
    media.addEventListener("change", bump);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", bump);
    };
  }, []);

  const panes = useMemo(
    () =>
      INDICATORS.filter(
        (d) => d.placement === "pane" && settings.indicators.includes(d.id) && results[d.id],
      ),
    [settings.indicators, results],
  );

  // Build the chart. Rebuilding on every change is simple and takes a few milliseconds.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !bars || !data) return;
    let disposed = false;
    const started = performance.now();
    void loadLib().then((lc) => {
      if (disposed) return;
      const up = cssColor("--up");
      const down = cssColor("--down");
      const chart = lc.createChart(container, {
        autoSize: true,
        layout: {
          background: { type: lc.ColorType.Solid, color: cssColor("--surface") },
          textColor: cssColor("--muted-foreground"),
          fontFamily: getComputedStyle(document.body).fontFamily,
          attributionLogo: true,
          panes: { separatorColor: cssColor("--border") },
        },
        grid: {
          vertLines: { color: cssColor("--muted") },
          horzLines: { color: cssColor("--muted") },
        },
        rightPriceScale: { borderColor: cssColor("--border") },
        timeScale: { borderColor: cssColor("--border") },
        crosshair: { mode: lc.CrosshairMode.Normal },
        localization: { priceFormatter: (p: number) => formatNumber(p) },
      });
      chartRef.current = chart;

      const main: ISeriesApi<SeriesType> =
        settings.type === "candles"
          ? chart.addSeries(lc.CandlestickSeries, {
              // Hollow up candles, filled down candles: direction without relying on color.
              upColor: "rgba(0,0,0,0)",
              borderUpColor: up,
              wickUpColor: up,
              downColor: down,
              borderDownColor: down,
              wickDownColor: down,
            })
          : chart.addSeries(lc.LineSeries, { color: cssColor("--primary"), lineWidth: 2 });
      main.setData(
        settings.type === "candles"
          ? bars.time.map((t, i) => ({
              time: t,
              open: bars.open[i]!,
              high: bars.high[i]!,
              low: bars.low[i]!,
              close: bars.close[i]!,
            }))
          : bars.time.map((t, i) => ({ time: t, value: bars.close[i]! })),
      );

      // Candles use the top three quarters of the price pane; volume sits in the bottom fifth.
      main.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.25 } });
      const volume = chart.addSeries(lc.HistogramSeries, {
        priceScaleId: "volume",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      volume.setData(
        bars.time.map((t, i) => ({
          time: t,
          value: bars.volume[i]!,
          color: withAlpha(bars.close[i]! >= bars.open[i]! ? up : down, 0.35),
        })),
      );

      const dates = new Set(bars.time);
      // Markers must be in time order; corporate actions sit above the bar, earnings below.
      const markers = [
        ...data.actions
          .filter((a) => dates.has(a.date))
          .map((a) => ({
            date: a.date,
            position: "aboveBar" as const,
            shape: a.type.includes("dividend") ? ("circle" as const) : ("square" as const),
            color: cssColor("--warning"),
            text: a.type === "cash_dividend" ? "D" : a.label,
          })),
        ...data.earnings
          .filter((d) => dates.has(d))
          .map((d) => ({
            date: d,
            position: "belowBar" as const,
            shape: "circle" as const,
            color: cssColor("--primary"),
            text: "E",
          })),
      ].sort((a, b) => a.date.localeCompare(b.date));
      lc.createSeriesMarkers(
        main,
        markers.map(({ date, ...m }) => ({ ...m, time: date as Time })),
      );

      const addLine = (
        values: (number | null)[],
        color: string,
        style: string | undefined,
        pane: number,
      ) => {
        const points = [];
        for (let i = 0; i < values.length; i += 1) {
          const v = values[i];
          if (v !== null && v !== undefined) points.push({ time: bars.time[i] as Time, value: v });
        }
        if (style === "histogram") {
          const s = chart.addSeries(
            lc.HistogramSeries,
            { lastValueVisible: false, priceLineVisible: false },
            pane,
          );
          s.setData(points.map((p) => ({ ...p, color: withAlpha(p.value >= 0 ? up : down, 0.5) })));
          return s;
        }
        const s = chart.addSeries(
          lc.LineSeries,
          {
            color,
            lineWidth: 1,
            lineStyle: style === "dashed" ? lc.LineStyle.Dashed : lc.LineStyle.Solid,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          },
          pane,
        );
        s.setData(points);
        return s;
      };

      for (const def of INDICATORS) {
        if (def.placement !== "overlay" || !results[def.id]) continue;
        for (const line of def.lines)
          addLine(results[def.id]![line.key] ?? [], line.color, line.style, 0);
      }
      panes.forEach((def, k) => {
        const paneIndex = k + 1;
        let first: ISeriesApi<SeriesType> | null = null;
        for (const line of def.lines) {
          const s = addLine(results[def.id]![line.key] ?? [], line.color, line.style, paneIndex);
          first ??= s;
        }
        for (const price of def.guides ?? []) {
          first?.createPriceLine({
            price,
            color: cssColor("--border"),
            lineWidth: 1,
            lineStyle: lc.LineStyle.Dotted,
            axisLabelVisible: false,
          });
        }
      });
      const allPanes = chart.panes();
      allPanes[0]?.setStretchFactor(PRICE_PANE);
      for (let i = 1; i < allPanes.length; i += 1) allPanes[i]!.setStretchFactor(INDICATOR_PANE);

      const onCrosshair = (p: MouseEventParams) => {
        setHover(p.time ? bars.time.indexOf(p.time as string) : null);
      };
      chart.subscribeCrosshairMove(onCrosshair);

      const from = timeframeStart(settings.tf, bars.time.at(-1)!);
      if (from && from > bars.time[0]!) {
        chart.timeScale().setVisibleRange({ from: from, to: bars.time.at(-1)! });
      } else {
        chart.timeScale().fitContent();
      }
      requestAnimationFrame(() => {
        // Recorded for the performance budget test (2,500 bars in under 300 ms).
        container.dataset.renderMs = String(Math.round(performance.now() - started));
        container.dataset.ready = "true";
      });
    });
    return () => {
      disposed = true;
      delete container.dataset.ready;
      chartRef.current?.remove();
      chartRef.current = null;
    };
  }, [bars, data, results, panes, settings.type, settings.tf, themeVersion]);

  const setTimeframe = useCallback((tf: Timeframe) => setSettings((s) => ({ ...s, tf })), []);

  // [ and ] step through timeframes (spec §6 keyboard shortcuts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "[" && e.key !== "]") return;
      setSettings((s) => {
        const i = TIMEFRAMES.indexOf(s.tf);
        const next = e.key === "[" ? Math.max(0, i - 1) : Math.min(TIMEFRAMES.length - 1, i + 1);
        return { ...s, tf: TIMEFRAMES[next]! };
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleIndicator = (id: string) =>
    setSettings((s) => ({
      ...s,
      indicators: s.indicators.includes(id)
        ? s.indicators.filter((x) => x !== id)
        : [...s.indicators, id],
    }));

  // The visible window, for the legend, the summary and the data table.
  const visible = useMemo(() => {
    if (!bars?.time.length) return null;
    const from = timeframeStart(settings.tf, bars.time.at(-1)!);
    const start = from
      ? Math.max(
          0,
          bars.time.findIndex((t) => t >= from),
        )
      : 0;
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = start; i < bars.time.length; i += 1) {
      hi = Math.max(hi, bars.high[i]!);
      lo = Math.min(lo, bars.low[i]!);
    }
    const first = bars.close[start]!;
    const last = bars.close.at(-1)!;
    return { start, first, last, change: last / first - 1, hi, lo };
  }, [bars, settings.tf]);

  const legendIndex = hover !== null && hover >= 0 ? hover : bars ? bars.time.length - 1 : -1;
  const benchmarkMissing = settings.indicators.includes("rs") && data && !benchmark;

  return (
    <section aria-label={`${ticker} price chart`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Timeframe" className="flex gap-1">
          {TIMEFRAMES.map((tf) => (
            <Button
              key={tf}
              size="sm"
              variant={settings.tf === tf ? "primary" : "ghost"}
              aria-pressed={settings.tf === tf}
              onClick={() => setTimeframe(tf)}
            >
              {tf}
            </Button>
          ))}
        </div>
        <div role="group" aria-label="Chart type" className="flex gap-1">
          {(["candles", "line"] as const).map((type) => (
            <Button
              key={type}
              size="sm"
              variant={settings.type === type ? "secondary" : "ghost"}
              aria-pressed={settings.type === type}
              onClick={() => setSettings((s) => ({ ...s, type }))}
            >
              {type === "candles" ? "Candles" : "Line"}
            </Button>
          ))}
        </div>
        <label className="flex min-h-8 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.adjusted}
            onChange={(e) => setSettings((s) => ({ ...s, adjusted: e.target.checked }))}
            className="size-4"
          />
          Adjusted
        </label>
        <details className="relative">
          <summary className="flex min-h-8 cursor-pointer list-none items-center rounded-md border px-2.5 text-sm hover:bg-muted">
            Indicators ({settings.indicators.length})
          </summary>
          <div className="absolute z-20 mt-1 grid w-[min(34rem,90vw)] grid-cols-1 gap-x-6 rounded-lg border bg-surface p-3 shadow-xl sm:grid-cols-2">
            {(["overlay", "pane"] as const).map((placement) => (
              <fieldset key={placement} className="flex flex-col gap-1">
                <legend className="mb-1 text-xs font-medium text-muted-foreground">
                  {placement === "overlay" ? "On the price" : "Below the price"}
                </legend>
                {INDICATORS.filter((d) => d.placement === placement).map((d) => (
                  <label key={d.id} className="flex min-h-7 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={settings.indicators.includes(d.id)}
                      onChange={() => toggleIndicator(d.id)}
                    />
                    <span
                      aria-hidden
                      className="inline-block h-0.5 w-4"
                      style={{ background: d.lines[0]!.color }}
                    />
                    {d.label}
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        </details>
      </div>

      {bars && legendIndex >= 0 ? (
        <p className="flex flex-wrap gap-x-4 text-xs text-muted-foreground" aria-hidden>
          <span>{formatDate(bars.time[legendIndex])}</span>
          <span>O {formatNumber(bars.open[legendIndex])}</span>
          <span>H {formatNumber(bars.high[legendIndex])}</span>
          <span>L {formatNumber(bars.low[legendIndex])}</span>
          <span>C {formatNumber(bars.close[legendIndex])}</span>
          <span>V {formatCompact(bars.volume[legendIndex])}</span>
          {INDICATORS.filter((d) => results[d.id]).flatMap((d) =>
            d.lines.map((line) => {
              const v = results[d.id]![line.key]?.[legendIndex];
              return (
                <span key={`${d.id}-${line.key}`} style={{ color: line.color }}>
                  {d.lines.length > 1 ? `${d.label} ${line.label}` : line.label}{" "}
                  {v === null || v === undefined ? "—" : formatNumber(v)}
                </span>
              );
            }),
          )}
        </p>
      ) : null}

      {error ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border p-6">
          <p>{error}</p>
          <Button onClick={() => setAttempt((a) => a + 1)}>Try again</Button>
        </div>
      ) : (
        <div className="relative">
          {!data ? <Skeleton className="absolute inset-0" style={{ height: PRICE_PANE }} /> : null}
          <p className="sr-only" aria-live="polite">
            {visible && data
              ? `${ticker}, ${settings.tf}: from ${formatNumber(visible.first)} to ${formatNumber(visible.last)} (${formatPercent(visible.change)}); high ${formatNumber(visible.hi)}, low ${formatNumber(visible.lo)}. The data table below lists every session.`
              : `${ticker} chart loading`}
          </p>
          <div
            ref={containerRef}
            data-testid="price-chart"
            className="w-full overflow-hidden rounded-lg border"
            style={{ height: PRICE_PANE + panes.length * INDICATOR_PANE }}
          />
        </div>
      )}

      {benchmarkMissing ? (
        <p className="text-xs text-muted-foreground">
          Relative strength needs SPY in the universe; it is not loaded.
        </p>
      ) : null}

      {data ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex flex-wrap items-center gap-2">
            <DataLabel
              source={data.source}
              kind="eod"
              asOf={data.asOf}
              fetchedAt={data.fetchedAt}
            />
            <span>· {COPY.adjusted(data.adjusted)}</span>
          </span>
          <a
            href={COPY.chartAttributionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            {COPY.chartAttribution}
          </a>
        </div>
      ) : null}

      {bars && visible ? (
        <div>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showTable}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? "Hide" : "Show"} data table ({bars.time.length - visible.start} sessions)
          </Button>
          {showTable ? (
            <div
              // Scrollable, so it must be reachable from the keyboard (WCAG 2.1.1).
              tabIndex={0}
              role="region"
              aria-label={`${ticker} data table`}
              className="mt-2 max-h-96 overflow-y-auto rounded-lg border"
            >
              <table className="w-full text-sm">
                <caption className="sr-only">
                  {ticker} daily bars for {settings.tf}, newest first,{" "}
                  {COPY.adjusted(settings.adjusted).toLowerCase()}
                </caption>
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    {["Date", "Open", "High", "Low", "Close", "Volume"].map((h, i) => (
                      <th
                        key={h}
                        scope="col"
                        className={cn(
                          "border-b px-3 py-1.5 text-xs font-medium",
                          i > 0 && "text-right",
                        )}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: bars.time.length - visible.start }, (_, k) => {
                    const i = bars.time.length - 1 - k;
                    return (
                      <tr key={bars.time[i]}>
                        <td className="px-3 py-1">{formatDate(bars.time[i])}</td>
                        <td className="px-3 py-1 text-right">{formatNumber(bars.open[i])}</td>
                        <td className="px-3 py-1 text-right">{formatNumber(bars.high[i])}</td>
                        <td className="px-3 py-1 text-right">{formatNumber(bars.low[i])}</td>
                        <td className="px-3 py-1 text-right">{formatNumber(bars.close[i])}</td>
                        <td className="px-3 py-1 text-right">{formatCompact(bars.volume[i])}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
