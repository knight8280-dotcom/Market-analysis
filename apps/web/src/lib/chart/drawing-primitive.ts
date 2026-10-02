import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import { fibLevels, sessionIndex, type Drawing, type DrawingPoint } from "./drawings";

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];
type Ctx = CanvasRenderingContext2D;

export interface DrawingColors {
  line: string;
  /** Rectangle fill, translucent. */
  fill: string;
  text: string;
  /** Behind labels, so they stay readable over candles. */
  background: string;
}

const price = (p: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(p);

/**
 * Draws the owner's drawings on the price pane, as a Lightweight Charts series primitive (the
 * library's plugin interface; it redraws them on every pan, zoom and resize). Points sit on
 * sessions by index, so a date on a weekend or holiday lands on the session before it.
 */
export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private drawings: readonly Drawing[] = [];
  private pending: DrawingPoint | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(
    private readonly times: readonly string[],
    private readonly colors: DrawingColors,
  ) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.views = [{ zOrder: () => "top", renderer: () => renderer }];
  }

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** Replaces what is drawn: the saved drawings and the first point of one being placed. */
  set(drawings: readonly Drawing[], pending: DrawingPoint | null): void {
    this.drawings = drawings;
    this.pending = pending;
    this.requestUpdate?.();
  }

  private x(time: string): number | null {
    const i = sessionIndex(this.times, time);
    if (i < 0 || !this.chart) return null;
    return this.chart.timeScale().logicalToCoordinate(i as Logical);
  }

  private y(value: number): number | null {
    return this.series?.priceToCoordinate(value) ?? null;
  }

  private draw(target: Target): void {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const ctx = context;
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = this.colors.line;
      ctx.font = "12px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      for (const d of this.drawings) this.drawOne(ctx, d, mediaSize.width);
      if (this.pending) {
        const x = this.x(this.pending.time);
        const y = this.y(this.pending.price);
        if (x !== null && y !== null) this.anchor(ctx, x, y);
      }
      ctx.restore();
    });
  }

  private anchor(ctx: Ctx, x: number, y: number): void {
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = this.colors.line;
    ctx.fill();
  }

  private label(ctx: Ctx, text: string, x: number, y: number, align: "left" | "right"): void {
    const width = ctx.measureText(text).width;
    const left = align === "left" ? x : x - width - 8;
    ctx.fillStyle = this.colors.background;
    ctx.fillRect(left, y - 9, width + 8, 18);
    ctx.fillStyle = this.colors.text;
    ctx.fillText(text, left + 4, y);
  }

  private line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, dashed = false): void {
    ctx.setLineDash(dashed ? [4, 4] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawOne(ctx: Ctx, d: Drawing, width: number): void {
    const [a, b] = d.points;
    if (!a) return;
    const x1 = this.x(a.time);
    const y1 = this.y(a.price);
    if (d.kind === "horizontal") {
      if (y1 === null) return;
      this.line(ctx, 0, y1, width, y1);
      this.label(
        ctx,
        d.label ? `${d.label} ${price(a.price)}` : price(a.price),
        width - 4,
        y1,
        "right",
      );
      return;
    }
    if (x1 === null || y1 === null) return;
    if (d.kind === "text") {
      this.anchor(ctx, x1, y1);
      this.label(ctx, d.label ?? "", x1 + 6, y1, "left");
      return;
    }
    if (!b) return;
    const x2 = this.x(b.time);
    const y2 = this.y(b.price);
    if (x2 === null || y2 === null) return;
    switch (d.kind) {
      case "trendline":
        this.line(ctx, x1, y1, x2, y2);
        this.anchor(ctx, x1, y1);
        this.anchor(ctx, x2, y2);
        break;
      case "rectangle":
        ctx.fillStyle = this.colors.fill;
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        break;
      case "fibonacci": {
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        this.line(ctx, x1, y1, x2, y2, true);
        for (const level of fibLevels(a.price, b.price)) {
          const y = this.y(level.price);
          if (y === null) continue;
          this.line(ctx, left, y, right, y);
          this.label(
            ctx,
            `${(level.level * 100).toFixed(1)}% ${price(level.price)}`,
            right + 4,
            y,
            "left",
          );
        }
        break;
      }
    }
  }
}
