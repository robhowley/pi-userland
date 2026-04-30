import fs from "node:fs";
import path from "node:path";
import type { ParserConfigFile, ParserRegistration } from "../types";

export function loadProjectConfig(cwd: string): ParserRegistration[] {
  const configPath = path.join(cwd, ".pi", "structured-return.json");
  if (!fs.existsSync(configPath)) return [];
  const data = JSON.parse(fs.readFileSync(configPath, "utf8")) as ParserConfigFile;
  return Array.isArray(data.parsers) ? data.parsers : [];
}
