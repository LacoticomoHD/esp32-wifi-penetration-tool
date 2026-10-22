// Node-only Datei-Zugriff (Pfad-basiert). Hält die fs-Abhängigkeit aus dem
// browsertauglichen engine.ts heraus, damit dieses sich bündeln lässt.

import { readFileSync } from 'node:fs';
import * as XLSXImport from 'xlsx';
import { parseCsv, pickSheetRows, rowsToActivities, computeKpis } from './engine';
import type { Activity, Kpis } from './types';

const XLSX = ((XLSXImport as unknown as { default?: typeof XLSXImport }).default ??
  XLSXImport) as typeof XLSXImport;

function readRows(path: string): unknown[][] {
  if (/\.(csv|tsv|txt)$/i.test(path)) {
    return parseCsv(readFileSync(path, 'utf8'));
  }
  return pickSheetRows(XLSX.readFile(path, { cellDates: true }));
}

/** Datei-Pfad → Aktivitäten (Node/CLI). */
export function parseActivities(path: string): Activity[] {
  return rowsToActivities(readRows(path));
}

/** Bequemer Einstieg: Datei → Kennzahlen (Node/CLI). */
export function analyzeFile(
  path: string,
  opts?: { goalPerMonth?: number },
): Kpis {
  return computeKpis(parseActivities(path), opts);
}
