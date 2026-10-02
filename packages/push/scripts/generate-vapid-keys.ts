import { generateVapidKeys } from "../src/vapid";

/**
 * Prints a new VAPID key pair for `.env` (RUNBOOK, "Push notifications"). The private key signs
 * every push message: keep it in `.env` only. Replacing the pair means every device subscribes
 * again.
 */
const keys = generateVapidKeys();
console.log(`WEB_PUSH_PUBLIC_KEY=${keys.publicKey}`);
console.log(`WEB_PUSH_PRIVATE_KEY=${keys.privateKey}`);
