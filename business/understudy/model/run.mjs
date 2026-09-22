#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { project, renderTable } from "./financial-model.mjs";

const assumptions = JSON.parse(
  await readFile(new URL("./assumptions.json", import.meta.url), "utf8"),
);
const result = project(assumptions);

process.stdout.write(
  process.argv.includes("--json")
    ? `${JSON.stringify(result, null, 2)}\n`
    : `\n  UNDERSTUDY — ${assumptions.months}-month operating model\n\n${renderTable(result)}`,
);
