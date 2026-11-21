// Fast drop-in for make.fun's csv-reader 1.0.0.
//
// Same answers as csv-reader 1.0.0's readCsv on every input, produced by a
// different route: the reference walks the text one character at a time and
// grows each field one character at a time; this module instead jumps between
// delimiters with indexOf (implemented in C++ in V8) and cuts fields out with
// slice, so the common case costs a few scans per field instead of one loop
// iteration per character. Nothing is cached between calls; run(input) is
// pure and answers each case alone.
//
// The broken-row policy is csv-reader's own, reproduced exactly:
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it is one quote, and each CRLF or lone CR inside
//     it is read as LF; what follows its closing quote, up to the next comma
//     or line break, is appended as it stands (quote_junk, when the field
//     ends); a quote that never closes is a literal character, and the text
//     after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based
//     line its record starts on, counting every LF, CRLF and lone CR inside
//     quotes, and row is its record's index in rows, null for the header.

// How a field ended: 0 at a comma, 1 at a line break, 2 at the end of text.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  const len = text.length;
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Finishes a record that is a real record (not a stray-CR-only line):
  // sets the width, takes the header, or pads/cuts and keeps the row.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended; `added` counts the characters kept after `value`.
  // The scan jumps delimiter to delimiter: the nearest comma or LF bounds
  // the slice, and CRs are only looked for inside that slice, so a stray
  // CR far ahead is never scanned for.
  function readUnquoted(p, value) {
    let added = 0;
    for (;;) {
      const nc = text.indexOf(',', p);
      const nn = text.indexOf('\n', p);
      let end;
      if (nc === -1) end = nn;
      else if (nn === -1) end = nc;
      else end = nc < nn ? nc : nn;
      if (end === -1) {
        if (p < len) {
          const seg = text.slice(p, len);
          const cr = seg.indexOf('\r');
          if (cr === -1) {
            value += seg;
            added += seg.length;
          } else {
            // Every CR here is stray: no LF follows any of them (there is
            // no LF left in the text at all).
            for (let i = 0; i < seg.length; i++) {
              if (seg.charCodeAt(i) === 13) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            }
            const clean = seg.replaceAll('\r', '');
            value += clean;
            added += clean.length;
          }
        }
        pos = len;
        return { value, ended: END, added };
      }
      const seg = text.slice(p, end);
      const cr = seg.indexOf('\r');
      if (cr === -1) {
        if (seg.length > 0) {
          value += seg;
          added += seg.length;
        }
        if (text.charCodeAt(end) === 44) {
          pos = end + 1;
          return { value, ended: COMMA, added };
        }
        pos = end + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // A CR sits inside the slice. The only CR that is not stray is a
      // trailing one just before the LF that ends the slice (CRLF).
      const isLF = text.charCodeAt(end) === 10;
      let body = seg;
      if (isLF && seg.charCodeAt(seg.length - 1) === 13) {
        body = seg.slice(0, -1);
      }
      const clean0 = body.replaceAll('\r', '');
      const ncr = body.length - clean0.length;
      let clean = clean0;
      if (ncr > 0) {
        for (let i = 0; i < ncr; i++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      }
      if (clean.length > 0) {
        value += clean;
        added += clean.length;
      }
      if (isLF) {
        pos = end + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // A comma ends the slice: the CRs in it were all stray, and the
      // field ends at the comma.
      pos = end + 1;
      return { value, ended: COMMA, added };
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // The closing quote is the next quote that is not doubled.
    let q = text.indexOf('"', open + 1);
    let doubled = false;
    while (q !== -1 && text.charCodeAt(q + 1) === 34) {
      doubled = true;
      q = text.indexOf('"', q + 2);
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted(open + 1, '"');
    }
    let value = text.slice(open + 1, q);
    if (value.indexOf('\n') !== -1 || value.indexOf('\r') !== -1) {
      // CRLF and a lone CR inside quotes are each one LF, and each counts
      // as a line.
      const breaks = value.match(/\r\n|\r|\n/g);
      line += breaks === null ? 0 : breaks.length;
      value = value.replace(/\r\n?/g, '\n');
    }
    if (doubled) value = value.replaceAll('""', '"');
    pos = q + 1;
    if (pos >= len) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(pos, value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the rest of this physical line holds no quote, so the
    // record is exactly this line (no quoted field can span lines) and its
    // fields are one split. Stray CRs are the only errors such a record
    // can hold, and they are dropped before the split.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    const q0 = text.indexOf('"', pos);
    if (q0 === -1 || q0 >= lineEnd) {
      const isCRLF = nl !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13;
      const raw = text.slice(pos, isCRLF ? lineEnd - 1 : lineEnd);
      let fields;
      if (raw.indexOf('\r') === -1) {
        fields = raw.split(',');
      } else {
        const clean = raw.replaceAll('\r', '');
        const ncr = raw.length - clean.length;
        for (let i = 0; i < ncr; i++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        fields = clean.split(',');
      }
      pos = nl === -1 ? len : nl + 1;
      if (nl !== -1) line += 1;
      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '') continue;
      finishRecord(fields);
      continue;
    }

    // Slow path: this record holds a quote somewhere, so it is read field
    // by field (a quoted field may span lines).
    const fields = [];
    let ended;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      const field = quoted ? readQuoted() : readUnquoted(pos, '');
      fields.push(field.value);
      ended = field.ended;
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
