import pg from "pg";

/** Connection string from `--url <url>` or DATABASE_URL. */
export function targetUrl(argv = process.argv.slice(2)): string {
  const i = argv.indexOf("--url");
  const url = i >= 0 ? argv[i + 1] : process.env.DATABASE_URL;
  if (!url) {
    console.error("Set DATABASE_URL or pass --url <postgres-url>.");
    process.exit(2);
  }
  return url;
}

export async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: "market-migrations" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export function run(main: () => Promise<void>): void {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
