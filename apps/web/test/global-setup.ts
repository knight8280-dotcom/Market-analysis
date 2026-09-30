import { prepareTemplate } from "@market/db/testing";

export const TEMPLATE = "tmpl_web";

export default async function setup(): Promise<void> {
  await prepareTemplate(TEMPLATE);
}
