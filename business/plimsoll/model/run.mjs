#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { project, renderTable } from "./financial-model.mjs";

const path = new URL("./assumptions.json", import.meta.url);
const assumptions = JSON.parse(await readFile(path, "utf8"));
const result = project(assumptions);

process.stdout.write(
  process.argv.includes("--json")
    ? `${JSON.stringify(result, null, 2)}\n`
    : `\n  PLIMSOLL — ${assumptions.months}-month operating model\n\n${renderTable(result)}`,
);
