#!/usr/bin/env node
// Fails when a production dependency carries a copyleft license we have not approved (spec §8:
// "license checks (block GPL/AGPL in the client bundle unless approved)"). We apply the rule to
// every workspace's production dependencies, which is stricter than the client bundle alone.
// Approved exceptions go in APPROVED below with a reason and a DECISIONS.md reference.
import { execFileSync } from "node:child_process";

const BLOCKED = /\b(A?GPL|LGPL|SSPL|EUPL|OSL)\b/i;

/** @type {Record<string, string>} package name -> reason for approval */
const APPROVED = {};

const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json", "--recursive"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
/** @type {Record<string, Array<{ name: string, versions: string[] }>>} */
const byLicense = raw.trim() ? JSON.parse(raw) : {};

const violations = [];
let count = 0;
for (const [license, packages] of Object.entries(byLicense)) {
  for (const pkg of packages) {
    count += 1;
    if (BLOCKED.test(license) && !APPROVED[pkg.name]) {
      violations.push(`${pkg.name}@${pkg.versions.join(",")} (${license})`);
    }
  }
}

if (violations.length > 0) {
  console.error("Blocked licenses in production dependencies:\n  " + violations.join("\n  "));
  process.exit(1);
}
console.log(`License check passed (${count} production packages).`);
