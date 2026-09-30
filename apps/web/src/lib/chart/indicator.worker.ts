import { computeIndicators, type ChartBars, type IndicatorResults } from "./catalog";

/** Computes indicators off the main thread when many are selected. */
export interface WorkerRequest {
  id: number;
  bars: ChartBars;
  benchmark: number[] | null;
  indicators: string[];
}
export interface WorkerResponse {
  id: number;
  results: IndicatorResults;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, bars, benchmark, indicators } = event.data;
  const response: WorkerResponse = { id, results: computeIndicators(bars, benchmark, indicators) };
  self.postMessage(response);
};
