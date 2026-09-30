import { seedFinancials } from "./seed";

export default async function globalSetup(): Promise<void> {
  const url = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set E2E_DATABASE_URL to a database with synthetic data");
  await seedFinancials(url);
}
