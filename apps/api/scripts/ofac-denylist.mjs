#!/usr/bin/env node
// Builds a denylist for UNPAIR_SCREENING=denylist from the US Treasury's SDN
// list: every "Digital Currency Address" on it, one per line, with the asset
// and the SDN entry id after a #. Prints to stdout.
//
//   node apps/api/scripts/ofac-denylist.mjs > denylist.txt
//   node apps/api/scripts/ofac-denylist.mjs path/to/SDN.XML > denylist.txt
//
// Run it where you build, not on the server, and copy the file to the path in
// UNPAIR_SCREENING_DENYLIST. The API reads the file when it starts.
import { readFile } from "node:fs/promises";

const SOURCE = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML";

const xml = process.argv[2] ? await readFile(process.argv[2], "utf8") : await download(SOURCE);
const published = /<Publish_Date>([^<]+)<\/Publish_Date>/.exec(xml)?.[1] ?? "unknown";

const rows = new Map();
for (const entry of xml.split("<sdnEntry>").slice(1)) {
  const uid = /<uid>(\d+)<\/uid>/.exec(entry)?.[1] ?? "?";
  for (const id of entry.split("<id>").slice(1)) {
    const type = /<idType>Digital Currency Address - ([A-Z0-9]+)<\/idType>/.exec(id)?.[1];
    const address = /<idNumber>([^<]+)<\/idNumber>/.exec(id)?.[1]?.trim();
    if (!type || !address) continue;
    const key = address.toLowerCase();
    if (!rows.has(key)) rows.set(key, `${address}  # ${type} sdn ${uid}`);
  }
}
if (rows.size === 0) {
  console.error("No digital currency addresses found. The list format may have changed.");
  process.exit(1);
}

console.log(`# OFAC SDN digital currency addresses, published ${published}, ${rows.size} addresses.`);
console.log(`# Source: ${process.argv[2] ? "a local copy of " : ""}${SOURCE}`);
console.log("# Made by apps/api/scripts/ofac-denylist.mjs. Case does not matter. Text after # is ignored.");
for (const key of [...rows.keys()].sort()) console.log(rows.get(key));

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}
