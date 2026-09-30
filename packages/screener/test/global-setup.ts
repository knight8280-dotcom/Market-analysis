import { prepareTemplate } from "@market/db/testing";

export const TEMPLATE = "tmpl_screener";

export default async function setup(): Promise<void> {
  await prepareTemplate(TEMPLATE);
}
