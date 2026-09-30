/**
 * Repair for turns captured before the listener kept newlines: their
 * user_message / response_text were flattened to one line, so block syntax
 * cannot parse — headings need a line start, GFM table rows need line
 * breaks. Rebuild the two recognized patterns (`###` runs, pipe tables with
 * a dash-cell delimiter row) and leave everything else byte-identical.
 * Newline-carrying text from the fixed listener is returned untouched, so
 * this only ever fires on legacy rows.
 */

/** A GFM delimiter cell: `---`, `:---`, `---:`, `:---:`. */
const DASH_CELL = /^:?-{3,}:?$/;

/** Headings are line-start constructs; flattened text keeps them mid-line
 * after prose. Break the line before a `#` run that sits after spaces — but
 * not after a word character or another `#` (`C# 5`, `a ## b` stay inline). */
const breakHeadings = (text: string): string =>
  text.replace(/([^\w#\n])[ \t]+(#{1,6}[ \t])/g, "$1\n\n$2");

const isBlank = (cell: string): boolean => cell.trim() === "";

/**
 * Rebuild one flattened table from its cells. Flattening joined rows with
 * spaces, so every row boundary became an empty cell (`a | | b`) and the
 * delimiter row is a dash-cell run. Columns must be announced by the
 * delimiter run: the cells before it are the header, cells after it group
 * into rows of that width. A cell holding a newline (the heading pass marks
 * following prose that way) ends the table. Returns null unless the run is
 * confidently a table — a real header, and at least one complete data row.
 */
const rebuildTable = (
  cells: string[],
  dashStart: number,
): { table: string; start: number; end: number } | null => {
  let dashEnd = dashStart;
  while (dashEnd < cells.length && DASH_CELL.test(cells[dashEnd]!.trim()))
    dashEnd++;
  const columns = dashEnd - dashStart;
  // one dash cell next to prose (`text | --- | more`) is an artifact, not a
  // table — a confident rebuild needs a real header and data columns
  if (columns < 2) return null;
  // skip the row-boundary blanks between the header row and the delimiter
  let headerEnd = dashStart;
  while (headerEnd > 0 && isBlank(cells[headerEnd - 1]!)) headerEnd--;
  const headerStart = headerEnd - columns;
  if (headerStart < 0) return null;
  const header = cells.slice(headerStart, headerEnd).map((c) => c.trim());
  if (header.some(isBlank)) return null;
  // data rows: blanks are row separators, a newline cell is the prose that
  // follows the table
  let i = dashEnd;
  while (i < cells.length && isBlank(cells[i]!)) i++;
  const rows: string[][] = [];
  let row: string[] = [];
  let runIndices: number[] = []; // cells the current run was built from
  while (i < cells.length) {
    const cell = cells[i]!;
    if (cell.includes("\n")) break;
    if (isBlank(cell)) {
      if (row.length > 0) {
        if (row.length !== columns) break; // ragged run: the table ends here
        rows.push(row);
        row = [];
        runIndices = [];
      }
    } else {
      row.push(cell.trim());
      runIndices.push(i);
    }
    i++;
  }
  // the run before the prose (end of cells or a newline cell) may hold the
  // last complete rows glued to a short prose fragment — peel the rows off
  let proseFrom = i;
  if (row.length > 0) {
    while (row.length >= columns) {
      rows.push(row.splice(0, columns));
      runIndices.splice(0, columns);
    }
    if (row.length > 0) proseFrom = runIndices[0]!;
  }
  if (rows.length === 0) return null;
  const line = (rowCells: string[]) => `| ${rowCells.join(" | ")} |`;
  const table = [
    line(header),
    line(cells.slice(dashStart, dashEnd).map((c) => c.trim())),
    ...rows.map(line),
  ].join("\n");
  return { table, start: headerStart, end: proseFrom };
};

const rebuildTables = (text: string): string => {
  const cells = text.split("|");
  const pieces: string[] = [];
  // prose emitted right after a rebuilt table must start on its own line
  let afterTable = false;
  const emitProse = (t: string): void => {
    if (t === "") return;
    pieces.push(afterTable && !/^[ ]*\n/.test(t) ? `\n${t}` : t);
  };
  let cursor = 0; // cells below this are already emitted as prose
  let searchFrom = 0;
  let changed = false;
  while (searchFrom < cells.length) {
    if (!DASH_CELL.test(cells[searchFrom]!.trim())) {
      searchFrom++;
      continue;
    }
    const built = rebuildTable(cells, searchFrom);
    if (built === null) {
      searchFrom++;
      continue;
    }
    const prose = cells.slice(cursor, built.start).join("|");
    // the table must start its own line — flattened text glued the header
    // row onto the preceding sentence (or heading)
    emitProse(prose !== "" && !prose.endsWith("\n") ? `${prose}\n` : prose);
    pieces.push(built.table);
    changed = true;
    afterTable = true;
    cursor = built.end;
    searchFrom = built.end;
  }
  if (!changed) return text;
  emitProse(cells.slice(cursor).join("|"));
  return pieces.join("");
};

/**
 * Re-linearize flattened markdown; identity for anything that already has
 * line structure or shows no heading/table syntax.
 */
export const repairFlatMarkdown = (text: string): string => {
  if (text.includes("\n")) return text;
  const withHeadings = breakHeadings(text);
  return rebuildTables(withHeadings);
};
