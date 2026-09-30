import { prepareTemplate } from "@market/db/testing";
import { TEMPLATE } from "./helpers/context";

export default async function setup(): Promise<void> {
  await prepareTemplate(TEMPLATE);
}
