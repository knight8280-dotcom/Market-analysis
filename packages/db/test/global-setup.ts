import { prepareTemplate } from "../src/testing";

export const TEMPLATE = "tmpl_db";

export default async function setup(): Promise<void> {
  await prepareTemplate(TEMPLATE);
}
