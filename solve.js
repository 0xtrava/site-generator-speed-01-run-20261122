// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// run(input) returns byte-for-byte what makefun-site 1.0.0's build returns.
// Written from the makefun-site README + reference behaviour: same front matter,
// template dialect, Markdown subset, slug rule and report — only faster.
// Speed comes from: bulk HTML escaping (no per-character calls), a fused
// lex+render Markdown pass with no token objects, manual front-matter parsing
// without splitting the whole source, cached slugify with an ASCII fast path,
// per-source cards computed once, and a template interpreter whose scopes are
// prototype chains (no scope-walk, no per-item closure).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const HAS_ESC = /[&<>"']/;
/** HTML-escape; fast path returns the string untouched when nothing needs it. */
function esc(s) {
  if (!HAS_ESC.test(s)) return s;
  // '&' first, so the entities introduced here are not escaped again; string
  // replacements (no per-match callback) are the fastest replace form here.
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** JS \s: ASCII whitespace plus the Unicode whitespace code points. */
function isWS(code) {
  return code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
    code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
    code === 0x3000 || code === 0xfeff;
}
function isSpaceTab(code) { return code === 32 || code === 9; }

/** Slug of `text`, cached per build in `cache` (titles/headings/tags repeat a lot). */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  // ASCII fast path: NFKD is the identity on ASCII and there are no marks to drop.
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether `code` is a Unicode whitespace code point (the >127 ones). */
function isUnicodeWS(code) {
  return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
    code === 0x3000 || code === 0xfeff;
}

/** Word count: runs of non-whitespace, counted by one scan (no /\S+/g match array). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) inWord = false;
    else if (c > 127 && isUnicodeWS(c)) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** `rel` resolved from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = +raw.slice(0, 4); mo = +raw.slice(5, 7); d = +raw.slice(8, 10);
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // slug must not start with '-'; each '-' needs alnum before and after
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Parse front matter of `text` (line ends already "\n"): { data, body } or { error }. */
function parseFrontMatter(text) {
  // Collect the front-matter line ranges first (the close line must be found
  // before any line inside is judged, as in the reference).
  let firstEnd = text.indexOf('\n');
  if (firstEnd === -1) firstEnd = text.length;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  const starts = [];
  const ends = [];
  let pos = firstEnd + 1;
  let closeIdx = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    let e = text.indexOf('\n', pos);
    if (e === -1) e = text.length;
    const line = text.slice(pos, e);
    if (line === '---') { closeIdx = starts.length; closeEnd = e; break; }
    starts.push(pos);
    ends.push(e);
    if (e === text.length) break;
    pos = e + 1;
  }
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let li = 0; li < starts.length; li++) {
    const line = text.slice(starts[li], ends[li]);
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || line.charCodeAt(0) === 35) continue; // blank or '#' comment
    // key: [a-z_]+ ':' (' ' value)? — exactly the reference's LINE grammar.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      k++;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${li + 2} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${li + 2} is not "key: value"` };
    // strip trailing spaces/tabs
    let re = raw.length;
    while (re > 0 && isSpaceTab(raw.charCodeAt(re - 1))) re--;
    if (re !== raw.length) raw = raw.slice(0, re);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && isSpaceTab(line.charCodeAt(a))) a++;
  while (b > a && isSpaceTab(line.charCodeAt(b - 1))) b--;
  return line.slice(a, b);
}

function isLangChar(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 43 || code === 45;
}

/** Fence-open language of `line`, or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < line.length && isLangChar(line.charCodeAt(k))) k++;
  for (; k < line.length; k++) if (!isSpaceTab(line.charCodeAt(k))) return null;
  return line.slice(3, k === 3 ? 3 : k);
}
/** Whether `line` closes a fence: ``` then spaces/tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) if (!isSpaceTab(line.charCodeAt(k))) return false;
  return true;
}

/** Heading { depth, text } of `line`, or null (text must be non-empty). */
function headingOf(line) {
  let h = 0;
  while (h < 6 && line.charCodeAt(h) === 35) h++;
  if (h === 0 || line.charCodeAt(h) === 35) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let t = h;
  while (t < line.length && isSpaceTab(line.charCodeAt(t))) t++;
  let e = line.length;
  while (e > t && isSpaceTab(line.charCodeAt(e - 1))) e--;
  if (e === t) return null;
  return { depth: h, text: line.slice(t, e) };
}

function isHR(line) {
  const a = line.charCodeAt(0), b = line.charCodeAt(1), cc = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && cc === 45) || (a === 42 && b === 42 && cc === 42))) return false;
  for (let k = 3; k < line.length; k++) if (!isSpaceTab(line.charCodeAt(k))) return false;
  return true;
}

/** Bullet content of `line` ("- x" / "* x"), or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}
/** Ordered item { start, content } of `line`, or null. */
function orderedOf(line) {
  let d = 0;
  while (d < 9 && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d === 0) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { start: Number(line.slice(0, d)), content: line.slice(d + 2) };
}
/** A list-continuation line: 2+ spaces then a non-space. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  return k >= 2 && k < line.length && !isWS(line.charCodeAt(k));
}

/** What block `line` starts: 0 blank, 1 fence, 2 heading, 3 hr, 4 quote, 5 bullet, 6 ordered, 7 other. */
function blockKind(line) {
  if (line.length === 0) return 0;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankLine(line) ? 0 : 7;
  if (c0 === 96) return fenceLang(line) !== null ? 1 : 7;
  if (c0 === 35) return headingOf(line) !== null ? 2 : 7;
  if (c0 === 45 || c0 === 42) {
    if (isHR(line)) return 3;
    return line.charCodeAt(1) === 32 ? 5 : 7;
  }
  if (c0 === 62) return 4;
  if (c0 >= 48 && c0 <= 57) return orderedOf(line) !== null ? 6 : 7;
  return 7;
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  return blockKind(line) <= 3;
}

/** First index >= `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let b = 0;
    for (let k = j - 1; k >= from && s.charCodeAt(k) === 92; k--) b++;
    if (b % 2 === 1) { j = s.indexOf(what, j + 1); continue; }
    return j;
  }
  return -1;
}

/** First single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let b = 0;
    for (let k = j - 1; k >= from && s.charCodeAt(k) === 92; k--) b++;
    if (b % 2 === 1) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

/** The inline-special characters (` \ ` * [), one regex scanned from `lastIndex`. */
const INLINE_RE = /[\\`*[]/g;

/** Render inline Markdown of `s` into `out` (array of string parts). */
function inlineInto(s, env, out) {
  const n = s.length;
  let i = 0;
  let plain = 0;
  while (i < n) {
    INLINE_RE.lastIndex = i;
    const hit = INLINE_RE.exec(s);
    const sp = hit === null ? n : hit.index;
    if (sp >= n) break;
    const c = s[sp];
    if (c === '\\') {
      if (sp + 1 < n && ESCAPABLE.has(s[sp + 1])) {
        if (sp > plain) out.push(esc(s.slice(plain, sp)));
        out.push(esc(s[sp + 1]));
        i = sp + 2;
        plain = i;
      } else i = sp + 1; // a backslash that escapes nothing stays in the plain run
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', sp + 1);
      if (j > sp + 1) {
        if (sp > plain) out.push(esc(s.slice(plain, sp)));
        out.push('<code>', esc(s.slice(sp + 1, j)), '</code>');
        i = j + 1;
        plain = i;
      } else i = sp + 1;
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(sp + 1) === 42) {
        const j = findUnesc(s, '**', sp + 2);
        if (j > sp + 2) {
          if (sp > plain) out.push(esc(s.slice(plain, sp)));
          out.push('<strong>');
          inlineInto(s.slice(sp + 2, j), env, out);
          out.push('</strong>');
          i = j + 2;
          plain = i;
        } else i = sp + 2;
        continue;
      }
      const j = findSingleStar(s, sp + 1);
      if (j > sp + 1) {
        if (sp > plain) out.push(esc(s.slice(plain, sp)));
        out.push('<em>');
        inlineInto(s.slice(sp + 1, j), env, out);
        out.push('</em>');
        i = j + 1;
        plain = i;
      } else i = sp + 1;
      continue;
    }
    // c === '['
    const k = findUnesc(s, ']', sp + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !WS_RE.test(target)) {
      if (sp > plain) out.push(esc(s.slice(plain, sp)));
      out.push('<a href="', esc(env.link(target)), '">');
      inlineInto(s.slice(sp + 1, k), env, out);
      out.push('</a>');
      i = m + 1;
      plain = i;
    } else i = sp + 1;
  }
  if (n > plain) out.push(esc(s.slice(plain, n)));
}

function inlineStr(s, env) {
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

/**
 * `src` rendered: { html, toc, excerpt }. One fused pass over the lines —
 * no token array, no per-block object — writing straight into `out` parts.
 */
function renderMarkdown(src, env, slugCache) {
  const out = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  const n = src.length;
  let i = 0;
  while (i < n) {
    let j = src.indexOf('\n', i);
    if (j === -1) j = n;
    const line = src.slice(i, j);
    const kind = blockKind(line);
    if (kind === 0) { i = j + 1; continue; }
    if (kind === 1) {
      const lang = fenceLang(line);
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      const parts = [`<pre><code${cls}>`];
      i = j + 1;
      while (i < n) {
        let e2 = src.indexOf('\n', i);
        if (e2 === -1) e2 = n;
        const bl = src.slice(i, e2);
        if (isFenceClose(bl)) { i = e2 + 1; break; }
        parts.push(esc(bl), '\n');
        i = e2 + 1;
      }
      parts.push('</code></pre>\n');
      out.push(parts.join(''));
      continue;
    }
    if (kind === 2) {
      const hd = headingOf(line);
      const id = uniqueSlug(slugify(hd.text, slugCache), ids);
      if (hd.depth === 2 || hd.depth === 3) {
        const html = inlineStr(hd.text, env);
        out.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>\n`);
        toc.push({ level: hd.depth, id, html });
      } else {
        out.push(`<h${hd.depth} id="${id}">`);
        inlineInto(hd.text, env, out);
        out.push(`</h${hd.depth}>\n`);
      }
      i = j + 1;
      continue;
    }
    if (kind === 3) { out.push('<hr>\n'); i = j + 1; continue; }
    if (kind === 4) { // '>'
      const body = [];
      while (i < n) {
        let e2 = src.indexOf('\n', i);
        if (e2 === -1) e2 = n;
        const bl = src.slice(i, e2);
        if (bl.charCodeAt(0) !== 62) break;
        let b = bl.slice(1);
        if (b.charCodeAt(0) === 32) b = b.slice(1);
        body.push(trimLine(b));
        i = e2 + 1;
      }
      const lines = body.filter((l) => l !== '');
      if (lines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(lines.join('\n'), env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    if (kind === 5 || kind === 6) {
      const isOrdered = kind === 6;
      const start = isOrdered ? orderedOf(line).start : 1;
      const items = [];
      while (i < n) {
        let e2 = src.indexOf('\n', i);
        if (e2 === -1) e2 = n;
        const bl = src.slice(i, e2);
        const k2 = blockKind(bl);
        if (isOrdered ? k2 === 6 : k2 === 5) {
          items.push([trimLine(isOrdered ? orderedOf(bl).content : bulletOf(bl))]);
          i = e2 + 1;
        } else if (k2 === 7 && isContinued(bl)) {
          items[items.length - 1].push(trimLine(bl));
          i = e2 + 1;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      out.push(open, '\n');
      for (let q = 0; q < items.length; q++) {
        out.push('<li>');
        inlineInto(items[q].join('\n'), env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    // Paragraph: lines until a blank line, fence, heading or thematic break.
    const body = [trimLine(line)];
    i = j + 1;
    while (i < n) {
      let e2 = src.indexOf('\n', i);
      if (e2 === -1) e2 = n;
      const bl = src.slice(i, e2);
      if (endsParagraph(bl)) break;
      body.push(trimLine(bl));
      i = e2 + 1;
    }
    const joined = body.join('\n');
    if (excerpt === null) {
      const html = inlineStr(joined, env);
      excerpt = html;
      out.push('<p>', html, '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(joined, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * Scope is a null-prototype object whose prototype is the parent scope, so a
 * plain property read finds the innermost binding — exactly the reference's
 * "first name from the nearest scope holding it". `__proto__` can only be a
 * prototype, never a binding, so it reads as undefined, as in the reference.
 */
function lookup(scope, path) {
  let v = path[0] === '__proto__' ? undefined : scope[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth) {
  let s = '';
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        s += n.text;
        break;
      case 'var':
        s += esc(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        s += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) s += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One child scope reused across iterations: rendering is synchronous,
        // so each iteration's bindings are read before the next is written.
        const child = Object.create(scope);
        const loop = { index: 0, first: false, last: false, length: xs.length };
        child.loop = loop;
        for (let k = 0; k < xs.length; k++) {
          if (n.name === '__proto__') Object.defineProperty(child, '__proto__', { value: xs[k], configurable: true, enumerable: true, writable: true });
          else child[n.name] = xs[k];
          child.loop = loop; // after the element: the reference's vars literal puts loop last, so it wins over an element named "loop"
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          s += renderNodes(n.body, child, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) {
          if (t.fn !== null) s += t.fn(scope, ctx, depth + 1, TPL_HELPERS);
          else s += renderNodes(t.nodes, scope, ctx, depth + 1);
        }
        break;
      }
    }
  }
  return s;
}

// ---------------------------------------------------------------- template compilation
// A parsed template is compiled once per build into a plain JS function that
// returns its rendered string: no AST walk, no per-node dispatch, and path reads are
// direct scope/property accesses. If compilation ever fails, the interpreter
// above (same semantics) renders instead.

function getProp(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

const TPL_HELPERS = { esc, txt: textOf, truthy, G: getProp, render: renderNodes };

function pathExpr(path) {
  if (path[0] === '__proto__') return 'void 0';
  let e = `scope.${path[0]}`;
  for (let k = 1; k < path.length; k++) e = `H.G(${e},${JSON.stringify(path[k])})`;
  return e;
}

function genNodes(nodes, lines) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        lines.push(`s+=${JSON.stringify(n.text)};`);
        break;
      case 'var':
        lines.push(`s+=H.esc(H.txt(${pathExpr(n.path)}));`);
        break;
      case 'raw':
        lines.push(`s+=H.txt(${pathExpr(n.path)});`);
        break;
      case 'if': {
        lines.push(`if(H.truthy(${pathExpr(n.path)})!==${n.not ? 'true' : 'false'}){`);
        genNodes(n.then, lines);
        if (n.else !== null) {
          lines.push('}else{');
          genNodes(n.else, lines);
        }
        lines.push('}');
        break;
      }
      case 'for': {
        lines.push(`{const xs=${pathExpr(n.path)};if(Array.isArray(xs)){const cs=Object.create(scope);const lp={index:0,first:false,last:false,length:xs.length};for(let k=0;k<xs.length;k++){`);
        if (n.name === '__proto__') lines.push(`Object.defineProperty(cs,'__proto__',{value:xs[k],configurable:true,enumerable:true,writable:true});`);
        else lines.push(`cs.${n.name}=xs[k];`);
        lines.push('cs.loop=lp;lp.index=k+1;lp.first=k===0;lp.last=k===xs.length-1;{const scope=cs;');
        genNodes(n.body, lines);
        lines.push('}}}}');
        break;
      }
      case 'include':
        lines.push(`if(depth<8){const t=ctx.templates.get(${JSON.stringify(n.name)});if(t!==undefined){if(t.fn!==null)s+=t.fn(scope,ctx,depth+1,H);else s+=H.render(t.nodes,scope,ctx,depth+1);}}`);
        break;
    }
  }
}

function compileTemplate(nodes) {
  try {
    const lines = ['let s="";'];
    genNodes(nodes, lines);
    lines.push('return s;');
    return new Function('scope', 'ctx', 'depth', 'H', lines.join('\n'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the build

export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templates.set(name, { nodes, fn: compileTemplate(nodes) });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, sorted by path in code-unit order; .md sources, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in order: refused, generator-owned dir, post without date,
  // layout that is no template, draft. First failure is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug; newer/older links.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, named as first met in collection order.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages, each computed once (the reference recomputes words and
  // excerpts per render; the values are identical, the work is not repeated).
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of kept) s.card = cardOf(s);
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Layouts: pages, index pages, tag pages, tags index, then statics.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const ctx = { templates, escape: esc };
  // One scope object reused across renders: rendering is synchronous, so a
  // render's bindings are read before the next render overwrites them; a key
  // a render does not set reads as undefined, exactly as an absent binding.
  const scope = Object.create(null);
  scope.site = site;
  scope.tags = allTags;
  scope.recent = recent;
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    scope.page = vars.page;
    scope.posts = vars.posts;
    scope.pager = vars.pager;
    scope.tag = vars.tag;
    if (t.fn !== null) return t.fn(scope, ctx, 0, TPL_HELPERS);
    return renderNodes(t.nodes, scope, ctx, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
