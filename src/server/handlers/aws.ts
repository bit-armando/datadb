import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Solo los nombres de las secciones `[profile x]`/`[x]`; nunca se devuelve el contenido (claves). */
export function nombresDePerfilesAws(...archivos: string[]): string[] {
  const nombres = new Set<string>();
  for (const texto of archivos) {
    for (const m of texto.matchAll(/^\s*\[\s*(?:profile\s+)?([^\]\s]+)\s*\]/gm)) nombres.add(m[1]);
  }
  return [...nombres].sort();
}

const leer = (ruta: string) => readFile(ruta, "utf8").catch(() => "");

export async function listAwsProfilesHandler(): Promise<string[]> {
  const dir = path.join(os.homedir(), ".aws");
  return nombresDePerfilesAws(
    await leer(process.env.AWS_CONFIG_FILE ?? path.join(dir, "config")),
    await leer(process.env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(dir, "credentials"))
  );
}
