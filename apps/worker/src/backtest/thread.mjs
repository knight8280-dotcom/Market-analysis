// Worker-thread entry for one backtest (see runner.ts). Plain JavaScript because worker threads
// do not get tsx's TypeScript loader; tsImport loads the TypeScript implementation.
import { parentPort, workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";

const { runThread } = await tsImport("./thread-main.ts", import.meta.url);
parentPort.postMessage(await runThread(workerData));
