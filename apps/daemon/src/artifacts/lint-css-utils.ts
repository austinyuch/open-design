import {
  HTML_RAW_TEXT_ELEMENTS,
  endOfComment,
  endOfTag,
  findRawTextClose,
  scanTag,
  skipForeignContent,
  skipTemplateContent,
  type ScannedTag,
} from '@open-design/contracts/runtime/html-injection-points';

export const ROOT_FONT_PX = 16;

export const IMPORTANT_SUFFIX_RE = /(?<!\s)\s*!\s*important\s*$/i;

const ANSI_CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]+/g;

export interface CssDeclaration {
  prop: string;
  value: string;
}

export interface CssLeafRule {
  start: number;
  end: number;
  selector: string;
  body: string;
}

export interface StyleBlock {
  start: number;
  end: number;
  open: string;
  css: string;
  close: string;
}

export interface HtmlScannedTag {
  tagName: string;
  isClose: boolean;
  selfClosing: boolean;
  start: number;
  end: number;
  attrs: Map<string, string>;
}

export interface HtmlDocumentScanResult {
  documentMarkupWithoutSvg: string;
  styleBlocks: StyleBlock[];
  tags: HtmlScannedTag[];
  inlineStyleTags: HtmlScannedTag[];
  elementIds: Set<string>;
  nonEmptyTextOffsets: number[];
}

export interface ExtractAccessibleTextOptions {
  excludeFormControls?: boolean | undefined;
}

export interface ParseCssDeclarationsOptions {
  stripImportant?: boolean | undefined;
}

/**
 * Advance one character inside an open CSS single- or double-quoted string literal.
 * Handles `\\` escape sequences and terminates broken single-line strings at `\n` or `\r`.
 */
export function advanceCssString(
  input: string,
  index: number,
  quote: '\'' | '"',
): { nextIndex: number; nextQuote: '\'' | '"' | null } {
  const ch = input[index];
  if (ch === '\\') {
    return { nextIndex: Math.min(index + 2, input.length), nextQuote: quote };
  }
  if (ch === quote || ch === '\n' || ch === '\r') {
    return { nextIndex: index + 1, nextQuote: null };
  }
  return { nextIndex: index + 1, nextQuote: quote };
}

/** Length-preserving ASCII lowercase fold so UTF-16 character offsets stay exact. */
export function foldAsciiLower(input: string): string {
  return input.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Strip ANSI escape sequences and ASCII/C1 control characters from lint text or prompt excerpts. */
export function stripLintControls(raw: string): string {
  if (!raw) return '';
  return raw.replace(ANSI_CSI_RE, ' ').replace(CONTROL_CHARS_RE, ' ');
}

/** Collapse whitespace, strip terminal escape/control sequences, and clamp inline lint text without splitting UTF-16 surrogates. */
export function sanitizeLintText(raw: string, maxLen = 200): string {
  if (!raw) return '';
  const cleaned = stripLintControls(raw).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  let cut = Math.max(0, maxLen - 1);
  if (cut > 0) {
    const prev = cleaned.charCodeAt(cut - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) {
      cut -= 1;
    }
  }
  return `${cleaned.slice(0, cut)}…`;
}

function isTagBoundary(ch: string | undefined): boolean {
  return ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isCloseTagBoundary(ch: string | undefined): boolean {
  return ch === '>' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function findClosingTagRange(
  html: string,
  lower: string,
  fromIndex: number,
  tagName: string,
): { closeStart: number; closeEnd: number } | null {
  const closeMarker = `</${tagName}`;
  let searchFrom = fromIndex;
  while (searchFrom < html.length) {
    const candidate = lower.indexOf(closeMarker, searchFrom);
    if (candidate === -1) return null;
    if (isCloseTagBoundary(lower[candidate + closeMarker.length])) {
      const bracket = html.indexOf('>', candidate + closeMarker.length);
      if (bracket === -1) return null;
      return { closeStart: candidate, closeEnd: bracket + 1 };
    }
    searchFrom = candidate + closeMarker.length;
  }
  return null;
}

const RAW_TEXT_ELEMENT_SET: ReadonlySet<string> = new Set(HTML_RAW_TEXT_ELEMENTS);
const FOREIGN_ELEMENT_SET: ReadonlySet<string> = new Set(['svg', 'math']);
const FORM_CONTROL_ELEMENT_SET: ReadonlySet<string> = new Set(['input', 'select', 'textarea']);
const EMPTY_ATTRS: Map<string, string> = new Map();

function isAsciiLowerAlpha(code: number): boolean {
  return code >= 97 && code <= 122;
}

type ParsedHtmlTagHead =
  | { kind: 'close'; tagName: string; start: number; endPos: number }
  | { kind: 'open'; tagName: string; start: number; tagEnd: number; scanned: ScannedTag }
  | { kind: 'skip'; endPos: number }
  | { kind: 'unterminated' };

function parseHtmlTagHead(html: string, lower: string, lt: number): ParsedHtmlTagHead | null {
  const n = html.length;
  const next = html[lt + 1];
  if (next === '!' || next === '?') {
    const end = html.indexOf('>', lt + 2);
    if (end === -1) return { kind: 'unterminated' };
    return { kind: 'skip', endPos: end + 1 };
  }
  if (next === '/') {
    const nameStart = lt + 2;
    if (nameStart >= n || !isAsciiLowerAlpha(lower.charCodeAt(nameStart))) {
      const end = html.indexOf('>', nameStart);
      if (end === -1) return { kind: 'unterminated' };
      return { kind: 'skip', endPos: end + 1 };
    }
    let nameEnd = nameStart + 1;
    while (nameEnd < n && !isTagBoundary(lower[nameEnd])) nameEnd += 1;
    const closeBracket = endOfTag(html, nameEnd);
    if (closeBracket === -1) return { kind: 'unterminated' };
    return {
      kind: 'close',
      tagName: lower.slice(nameStart, nameEnd),
      start: lt,
      endPos: closeBracket + 1,
    };
  }

  const nameStart = lt + 1;
  if (nameStart >= n || !isAsciiLowerAlpha(lower.charCodeAt(nameStart))) return null;
  let nameEnd = nameStart + 1;
  while (nameEnd < n && !isTagBoundary(lower[nameEnd])) nameEnd += 1;
  const scanned = scanTag(html, nameEnd);
  if (scanned.end === -1) return { kind: 'unterminated' };
  return {
    kind: 'open',
    tagName: lower.slice(nameStart, nameEnd),
    start: lt,
    tagEnd: scanned.end + 1,
    scanned,
  };
}

function isAsciiOrNbspWhitespace(ch: number): boolean {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12 || ch === 160;
}

function findFirstAccessibleCharOffset(
  html: string,
  lower: string,
  start: number,
  end: number,
): number {
  let i = start;
  while (i < end) {
    const ch = html.charCodeAt(i);
    if (isAsciiOrNbspWhitespace(ch)) {
      i += 1;
      continue;
    }
    if (ch === 38 /* & */) {
      if (i + 6 <= end && (lower.startsWith('&nbsp;', i) || html.startsWith('&#160;', i))) {
        i += 6;
        continue;
      }
    }
    return i;
  }
  return -1;
}

function hasAccessibleValue(raw: string | undefined): boolean {
  if (!raw) return false;
  const lower = foldAsciiLower(raw);
  return findFirstAccessibleCharOffset(raw, lower, 0, raw.length) !== -1;
}

function collectSvgAccessibleText(
  html: string,
  lower: string,
  openEnd: number,
  foreignEnd: number,
  svgAttrs: Map<string, string>,
): string[] {
  if (svgAttrs.get('aria-hidden')?.trim().toLowerCase() === 'true') {
    return [];
  }
  const chunks: string[] = [];
  const rootAriaLabel = svgAttrs.get('aria-label');
  if (rootAriaLabel && hasAccessibleValue(rootAriaLabel)) {
    chunks.push(rootAriaLabel.trim());
  }
  if (openEnd >= foreignEnd) return chunks;

  // Scope every SVG scan and raw-text close lookup strictly to `[openEnd, foreignEnd)`
  // so malformed foreign subtrees (e.g. `<svg><script></svg>`) cannot rescan to EOF.
  const svgHtml = html.slice(openEnd, foreignEnd);
  const svgLower = lower.slice(openEnd, foreignEnd);
  const svgLen = svgHtml.length;
  let pos = 0;

  while (pos < svgLen) {
    const lt = svgHtml.indexOf('<', pos);
    if (lt === -1) break;

    if (svgHtml.startsWith('<!--', lt)) {
      const commentEnd = endOfComment(svgHtml, lt);
      if (commentEnd === -1) break;
      pos = commentEnd;
      continue;
    }
    if (svgLower.startsWith('<![cdata[', lt)) {
      const cdataEnd = svgHtml.indexOf(']]>', lt + 9);
      if (cdataEnd === -1) break;
      pos = cdataEnd + 3;
      continue;
    }

    const parsed = parseHtmlTagHead(svgHtml, svgLower, lt);
    if (!parsed) {
      pos = lt + 1;
      continue;
    }
    if (parsed.kind === 'unterminated') break;
    if (parsed.kind === 'close' || parsed.kind === 'skip') {
      pos = parsed.endPos;
      continue;
    }

    const { tagName, tagEnd, scanned } = parsed;

    if (tagName === 'style' || tagName === 'script') {
      const close = findRawTextCloseRange(svgHtml, svgLower, tagName, tagEnd);
      if (!close) break;
      pos = close.closeEnd;
      continue;
    }

    const childHidden = scanned.attrs.get('aria-hidden')?.trim().toLowerCase() === 'true';
    if (!childHidden) {
      const childAriaLabel = scanned.attrs.get('aria-label');
      if (childAriaLabel && hasAccessibleValue(childAriaLabel)) {
        chunks.push(childAriaLabel.trim());
      }
      if (tagName === 'title' && !scanned.selfClosing) {
        const titleParts: string[] = [];
        let titleCursor = tagEnd;
        let titlePos = tagEnd;
        let closedTitleEnd = svgLen;
        while (titlePos < svgLen) {
          const tLt = svgHtml.indexOf('<', titlePos);
          if (tLt === -1) {
            if (svgLen > titleCursor) titleParts.push(svgHtml.slice(titleCursor, svgLen));
            titleCursor = svgLen;
            break;
          }
          if (svgHtml.startsWith('<!--', tLt)) {
            if (tLt > titleCursor) titleParts.push(svgHtml.slice(titleCursor, tLt));
            const end = endOfComment(svgHtml, tLt);
            if (end === -1) {
              titleCursor = svgLen;
              break;
            }
            titleCursor = end;
            titlePos = end;
            continue;
          }
          if (svgLower.startsWith('<![cdata[', tLt)) {
            if (tLt > titleCursor) titleParts.push(svgHtml.slice(titleCursor, tLt));
            const cdataEnd = svgHtml.indexOf(']]>', tLt + 9);
            if (cdataEnd === -1) {
              titleParts.push(svgHtml.slice(tLt + 9));
              titleCursor = svgLen;
              break;
            }
            titleParts.push(svgHtml.slice(tLt + 9, cdataEnd));
            titleCursor = cdataEnd + 3;
            titlePos = cdataEnd + 3;
            continue;
          }
          const tParsed = parseHtmlTagHead(svgHtml, svgLower, tLt);
          if (!tParsed) {
            titlePos = tLt + 1;
            continue;
          }
          if (tParsed.kind === 'unterminated') {
            if (tLt > titleCursor) titleParts.push(svgHtml.slice(titleCursor, tLt));
            titleCursor = svgLen;
            break;
          }
          if (tLt > titleCursor) titleParts.push(svgHtml.slice(titleCursor, tLt));
          if (tParsed.kind === 'close' && tParsed.tagName === 'title') {
            closedTitleEnd = tParsed.endPos;
            titleCursor = closedTitleEnd;
            break;
          }
          const skipEnd = tParsed.kind === 'open' ? tParsed.tagEnd : tParsed.endPos;
          titleCursor = skipEnd;
          titlePos = skipEnd;
        }
        if (titleCursor < svgLen && closedTitleEnd === svgLen) {
          titleParts.push(svgHtml.slice(titleCursor, svgLen));
        }
        const titleText = titleParts
          .join('')
          .replace(/&nbsp;|&#160;/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (titleText) chunks.push(titleText);
        pos = closedTitleEnd;
        continue;
      }
    }

    pos = tagEnd;
  }

  return chunks;
}

function scanSvgHasAccessibleText(
  html: string,
  lower: string,
  openEnd: number,
  foreignEnd: number,
  svgAttrs: Map<string, string>,
): boolean {
  return collectSvgAccessibleText(html, lower, openEnd, foreignEnd, svgAttrs).length > 0;
}

function findRawTextCloseRange(
  html: string,
  lower: string,
  tagName: string,
  from: number,
): { closeStart: number; closeEnd: number } | null {
  const closeStart = findRawTextClose(lower, tagName, from);
  if (closeStart === -1) return null;
  const closeBracket = endOfTag(html, closeStart + 2 + tagName.length);
  if (closeBracket === -1) return null;
  return { closeStart, closeEnd: closeBracket + 1 };
}

/** Linear single-pass CSS comment stripper that preserves quoted string literals and avoids token merging. */
export function stripCssComments(css: string): string {
  const out: string[] = [];
  let quote: '\'' | '"' | null = null;
  let chunkStart = 0;
  let i = 0;
  const n = css.length;

  while (i < n) {
    const ch = css[i];
    if (quote !== null) {
      const step = advanceCssString(css, i, quote);
      i = step.nextIndex;
      quote = step.nextQuote;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      if (i > chunkStart) out.push(css.slice(chunkStart, i));
      out.push(' ');
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      chunkStart = i;
      continue;
    }
    i += 1;
  }

  if (chunkStart < n) out.push(css.slice(chunkStart));
  return out.join('');
}

/**
 * Strip HTML comments in a single linear pass using WHATWG comment termination (`endOfComment`),
 * preserving raw-text contents (such as `"<!--"` inside `<script>` or `<style>`) and quoted attributes.
 */
export function stripHtmlComments(html: string): string {
  if (!html) return html;
  const lower = foldAsciiLower(html);
  const n = html.length;
  const out: string[] = [];
  let cursor = 0;
  let pos = 0;

  while (pos < n) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) break;

    if (html.startsWith('<!--', lt)) {
      if (lt > cursor) out.push(html.slice(cursor, lt));
      const commentEnd = endOfComment(html, lt);
      if (commentEnd === -1) {
        cursor = n;
        break;
      }
      cursor = commentEnd;
      pos = commentEnd;
      continue;
    }

    const parsed = parseHtmlTagHead(html, lower, lt);
    if (!parsed) {
      pos = lt + 1;
      continue;
    }
    if (parsed.kind === 'unterminated') break;
    if (parsed.kind === 'close' || parsed.kind === 'skip') {
      pos = parsed.endPos;
      continue;
    }

    if (parsed.tagName === 'template') {
      const tplEnd = parsed.scanned.selfClosing
        ? parsed.tagEnd
        : skipTemplateContent(html, lower, parsed.tagEnd);
      if (tplEnd === -1) break;
      pos = tplEnd;
      continue;
    }

    if (FOREIGN_ELEMENT_SET.has(parsed.tagName)) {
      const foreignEnd = parsed.scanned.selfClosing
        ? parsed.tagEnd
        : skipForeignContent(html, lower, parsed.tagName, parsed.tagEnd);
      if (foreignEnd === -1) break;
      pos = foreignEnd;
      continue;
    }

    pos = parsed.tagEnd;
    if (RAW_TEXT_ELEMENT_SET.has(parsed.tagName)) {
      const close = findRawTextCloseRange(html, lower, parsed.tagName, parsed.tagEnd);
      if (!close) break;
      pos = close.closeEnd;
    }
  }

  if (cursor < n) out.push(html.slice(cursor));
  return out.join('');
}

/** Locate `<style>...</style>` blocks linearly, skipping HTML comments, tag attributes, `<template>`, and raw-text elements. */
export function findStyleBlocks(html: string): StyleBlock[] {
  const blocks: StyleBlock[] = [];
  const lower = foldAsciiLower(html);
  const n = html.length;
  let pos = 0;

  while (pos < n) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) break;

    if (html.startsWith('<!--', lt)) {
      const commentEnd = endOfComment(html, lt);
      if (commentEnd === -1) break;
      pos = commentEnd;
      continue;
    }

    const parsed = parseHtmlTagHead(html, lower, lt);
    if (!parsed) {
      pos = lt + 1;
      continue;
    }
    if (parsed.kind === 'unterminated') break;
    if (parsed.kind === 'close' || parsed.kind === 'skip') {
      pos = parsed.endPos;
      continue;
    }

    const { tagName, tagEnd } = parsed;
    if (tagName === 'style') {
      const close = findRawTextCloseRange(html, lower, 'style', tagEnd);
      if (!close) break;
      blocks.push({
        start: lt,
        end: close.closeEnd,
        open: html.slice(lt, tagEnd),
        css: html.slice(tagEnd, close.closeStart),
        close: html.slice(close.closeStart, close.closeEnd),
      });
      pos = close.closeEnd;
      continue;
    }

    if (tagName === 'template') {
      const endPos = parsed.scanned.selfClosing ? tagEnd : skipTemplateContent(html, lower, tagEnd);
      if (endPos === -1) break;
      pos = endPos;
      continue;
    }

    if (RAW_TEXT_ELEMENT_SET.has(tagName)) {
      const close = findRawTextCloseRange(html, lower, tagName, tagEnd);
      if (!close) break;
      pos = close.closeEnd;
      continue;
    }

    pos = tagEnd;
  }

  return blocks;
}

/** Scan an HTML document in one linear pass for CSS blocks, SVG-stripped document markup, tags, inline styles, IDs, and accessible text offsets. */
export function scanHtmlDocument(html: string): HtmlDocumentScanResult {
  const lower = foldAsciiLower(html);
  const n = html.length;
  const docParts: string[] = [];
  const styleBlocks: StyleBlock[] = [];
  const tags: HtmlScannedTag[] = [];
  const inlineStyleTags: HtmlScannedTag[] = [];
  const elementIds = new Set<string>();
  const nonEmptyTextOffsets: number[] = [];

  let textCursor = 0;
  let docCursor = 0;
  let pos = 0;

  const flushTextRange = (end: number): void => {
    if (end > textCursor) {
      const charOffset = findFirstAccessibleCharOffset(html, lower, textCursor, end);
      if (charOffset !== -1) nonEmptyTextOffsets.push(charOffset);
    }
  };

  const recordOpenTag = (tagName: string, scanned: ScannedTag, start: number, end: number): void => {
    const entry: HtmlScannedTag = {
      tagName,
      isClose: false,
      selfClosing: scanned.selfClosing,
      start,
      end,
      attrs: scanned.attrs,
    };
    tags.push(entry);
    const idAttr = scanned.attrs.get('id')?.trim();
    if (idAttr) elementIds.add(idAttr);
    const styleAttr = scanned.attrs.get('style')?.trim();
    if (styleAttr) inlineStyleTags.push(entry);
  };

  while (pos < n) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) break;

    if (html.startsWith('<!--', lt)) {
      flushTextRange(lt);
      if (lt > docCursor) docParts.push(html.slice(docCursor, lt));
      const commentEnd = endOfComment(html, lt);
      if (commentEnd === -1) {
        textCursor = n;
        docCursor = n;
        break;
      }
      textCursor = commentEnd;
      docCursor = commentEnd;
      pos = commentEnd;
      continue;
    }

    const parsed = parseHtmlTagHead(html, lower, lt);
    if (!parsed) {
      pos = lt + 1;
      continue;
    }
    if (parsed.kind === 'unterminated') {
      flushTextRange(lt);
      textCursor = n;
      break;
    }

    flushTextRange(lt);

    if (parsed.kind === 'skip') {
      textCursor = parsed.endPos;
      pos = parsed.endPos;
      continue;
    }

    if (parsed.kind === 'close') {
      tags.push({
        tagName: parsed.tagName,
        isClose: true,
        selfClosing: false,
        start: lt,
        end: parsed.endPos,
        attrs: EMPTY_ATTRS,
      });
      textCursor = parsed.endPos;
      pos = parsed.endPos;
      continue;
    }

    const { tagName, tagEnd, scanned } = parsed;

    if (tagName === 'template') {
      if (lt > docCursor) docParts.push(html.slice(docCursor, lt));
      const tplEnd = scanned.selfClosing ? tagEnd : skipTemplateContent(html, lower, tagEnd);
      const endPos = tplEnd === -1 ? n : tplEnd;
      textCursor = endPos;
      docCursor = endPos;
      pos = endPos;
      continue;
    }

    if (tagName === 'style') {
      if (lt > docCursor) docParts.push(html.slice(docCursor, lt));
      const close = findRawTextCloseRange(html, lower, 'style', tagEnd);
      if (close) {
        styleBlocks.push({
          start: lt,
          end: close.closeEnd,
          open: html.slice(lt, tagEnd),
          css: html.slice(tagEnd, close.closeStart),
          close: html.slice(close.closeStart, close.closeEnd),
        });
        textCursor = close.closeEnd;
        docCursor = close.closeEnd;
        pos = close.closeEnd;
      } else {
        textCursor = n;
        docCursor = n;
        break;
      }
      continue;
    }

    if (tagName === 'title') {
      recordOpenTag('title', scanned, lt, tagEnd);

      const close = findRawTextCloseRange(html, lower, 'title', tagEnd);
      if (close) {
        tags.push({
          tagName: 'title',
          isClose: true,
          selfClosing: false,
          start: close.closeStart,
          end: close.closeEnd,
          attrs: EMPTY_ATTRS,
        });
        textCursor = close.closeEnd;
        pos = close.closeEnd;
      } else {
        textCursor = n;
        break;
      }
      continue;
    }

    if (RAW_TEXT_ELEMENT_SET.has(tagName)) {
      if (lt > docCursor) docParts.push(html.slice(docCursor, lt));
      if (tagName === 'textarea') {
        recordOpenTag('textarea', scanned, lt, tagEnd);
      }
      const close = findRawTextCloseRange(html, lower, tagName, tagEnd);
      if (tagName === 'textarea' && close) {
        tags.push({
          tagName: 'textarea',
          isClose: true,
          selfClosing: false,
          start: close.closeStart,
          end: close.closeEnd,
          attrs: EMPTY_ATTRS,
        });
      }
      const endPos = close ? close.closeEnd : n;
      textCursor = endPos;
      docCursor = endPos;
      pos = endPos;
      continue;
    }

    if (FOREIGN_ELEMENT_SET.has(tagName)) {
      const idAttr = scanned.attrs.get('id')?.trim();
      if (idAttr) elementIds.add(idAttr);
      if (lt > docCursor) docParts.push(html.slice(docCursor, lt));
      const foreignEnd = scanned.selfClosing
        ? tagEnd
        : skipForeignContent(html, lower, tagName, tagEnd);
      const endPos = foreignEnd === -1 ? n : foreignEnd;
      if (tagName === 'svg' && scanSvgHasAccessibleText(html, lower, tagEnd, endPos, scanned.attrs)) {
        nonEmptyTextOffsets.push(lt);
      }
      textCursor = endPos;
      docCursor = endPos;
      pos = endPos;
      continue;
    }

    recordOpenTag(tagName, scanned, lt, tagEnd);
    if (tagName === 'img') {
      if (hasAccessibleValue(scanned.attrs.get('alt'))) {
        nonEmptyTextOffsets.push(lt);
      }
    } else if (!FORM_CONTROL_ELEMENT_SET.has(tagName) && hasAccessibleValue(scanned.attrs.get('aria-label'))) {
      nonEmptyTextOffsets.push(lt);
    }
    textCursor = tagEnd;
    pos = tagEnd;
  }

  flushTextRange(n);
  if (docCursor < n) docParts.push(html.slice(docCursor));

  return {
    documentMarkupWithoutSvg: docParts.join(''),
    styleBlocks,
    tags,
    inlineStyleTags,
    elementIds,
    nonEmptyTextOffsets,
  };
}

/**
 * Extract plain accessible text from an HTML subtree in a single linear pass
 * without regex tag matching (`alt` on `<img>`, `aria-label`, and SVG `<title>` contribute).
 */
export function extractAccessibleText(
  fragment: string,
  options?: ExtractAccessibleTextOptions,
): string {
  if (!fragment) return '';
  const lower = foldAsciiLower(fragment);
  const n = fragment.length;
  const excludeForms = options?.excludeFormControls === true;
  const parts: string[] = [];
  let cursor = 0;
  let pos = 0;

  while (pos < n) {
    const lt = fragment.indexOf('<', pos);
    if (lt === -1) break;

    if (fragment.startsWith('<!--', lt)) {
      if (lt > cursor) parts.push(fragment.slice(cursor, lt));
      const commentEnd = endOfComment(fragment, lt);
      if (commentEnd === -1) {
        cursor = n;
        break;
      }
      cursor = commentEnd;
      pos = commentEnd;
      continue;
    }

    const parsed = parseHtmlTagHead(fragment, lower, lt);
    if (!parsed) {
      pos = lt + 1;
      continue;
    }
    if (parsed.kind === 'unterminated') {
      if (lt > cursor) parts.push(fragment.slice(cursor, lt));
      cursor = n;
      break;
    }

    if (lt > cursor) parts.push(fragment.slice(cursor, lt));

    if (parsed.kind === 'close' || parsed.kind === 'skip') {
      cursor = parsed.endPos;
      pos = parsed.endPos;
      continue;
    }

    const { tagName, tagEnd, scanned } = parsed;
    if (tagName === 'template') {
      const tplEnd = scanned.selfClosing ? tagEnd : skipTemplateContent(fragment, lower, tagEnd);
      const endPos = tplEnd === -1 ? n : tplEnd;
      cursor = endPos;
      pos = endPos;
      continue;
    }

    if (excludeForms && FORM_CONTROL_ELEMENT_SET.has(tagName)) {
      let endPos = tagEnd;
      if (tagName !== 'input') {
        const close = findRawTextCloseRange(fragment, lower, tagName, tagEnd);
        endPos = close ? close.closeEnd : n;
      }
      cursor = endPos;
      pos = endPos;
      continue;
    }

    if (FOREIGN_ELEMENT_SET.has(tagName)) {
      const foreignEnd = scanned.selfClosing
        ? tagEnd
        : skipForeignContent(fragment, lower, tagName, tagEnd);
      const endPos = foreignEnd === -1 ? n : foreignEnd;
      if (tagName === 'svg') {
        for (const chunk of collectSvgAccessibleText(fragment, lower, tagEnd, endPos, scanned.attrs)) {
          parts.push(` ${chunk} `);
        }
      } else if (scanned.attrs.get('aria-hidden')?.trim().toLowerCase() !== 'true') {
        const label = scanned.attrs.get('aria-label');
        if (label && hasAccessibleValue(label)) parts.push(` ${label.trim()} `);
      }
      cursor = endPos;
      pos = endPos;
      continue;
    }

    if (RAW_TEXT_ELEMENT_SET.has(tagName)) {
      const close = findRawTextCloseRange(fragment, lower, tagName, tagEnd);
      const endPos = close ? close.closeEnd : n;
      cursor = endPos;
      pos = endPos;
      continue;
    }

    if (tagName === 'img') {
      const alt = scanned.attrs.get('alt');
      if (alt) parts.push(` ${alt} `);
    } else if (scanned.attrs.has('aria-label')) {
      const label = scanned.attrs.get('aria-label');
      if (label) parts.push(` ${label} `);
    }

    cursor = tagEnd;
    pos = tagEnd;
  }

  if (cursor < n) parts.push(fragment.slice(cursor));
  return parts
    .join('')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip whole HTML tag blocks (opening through closing tag) linearly without backtracking. */
export function stripHtmlTagBlocks(html: string, tagNames: readonly string[]): string {
  if (tagNames.length === 0 || html.length === 0) return html;
  const lower = foldAsciiLower(html);
  const targets = tagNames.map((t) => foldAsciiLower(t));
  const out: string[] = [];
  let cursor = 0;
  let pos = 0;

  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) break;

    let matchedTag: string | null = null;
    for (const tag of targets) {
      if (lower.startsWith(tag, lt + 1) && isTagBoundary(lower[lt + 1 + tag.length])) {
        matchedTag = tag;
        break;
      }
    }
    if (!matchedTag) {
      pos = lt + 1;
      continue;
    }

    if (lt > cursor) out.push(html.slice(cursor, lt));
    const openEnd = endOfTag(html, lt + 1 + matchedTag.length);
    if (openEnd === -1) {
      cursor = html.length;
      break;
    }
    const closing = findClosingTagRange(html, lower, openEnd + 1, matchedTag);
    if (!closing) {
      cursor = html.length;
      break;
    }
    cursor = closing.closeEnd;
    pos = closing.closeEnd;
  }

  if (cursor < html.length) out.push(html.slice(cursor));
  return out.join('');
}

/** Scan comment-stripped CSS in a single linear pass for innermost leaf `selector { body }` rules. */
export function scanCssLeafRules(css: string): CssLeafRule[] {
  const out: CssLeafRule[] = [];
  const stack: Array<{ headerStart: number; openBrace: number; hasChildBlock: boolean }> = [];
  let quote: '\'' | '"' | null = null;
  let parenDepth = 0;
  let headerStart = 0;
  let i = 0;

  while (i < css.length) {
    const ch = css[i];
    if (quote !== null) {
      const step = advanceCssString(css, i, quote);
      i = step.nextIndex;
      quote = step.nextQuote;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '(') {
      parenDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth -= 1;
      i += 1;
      continue;
    }
    if (ch === ';' && parenDepth === 0) {
      headerStart = i + 1;
      i += 1;
      continue;
    }
    if (ch === '{') {
      const parent = stack[stack.length - 1];
      if (parent) parent.hasChildBlock = true;
      stack.push({ headerStart, openBrace: i, hasChildBlock: false });
      headerStart = i + 1;
      parenDepth = 0;
      i += 1;
      continue;
    }
    if (ch === '}') {
      parenDepth = 0;
      const frame = stack.pop();
      if (frame && !frame.hasChildBlock) {
        out.push({
          start: frame.headerStart,
          end: i + 1,
          selector: css.slice(frame.headerStart, frame.openBrace).trim(),
          body: css.slice(frame.openBrace + 1, i),
        });
      }
      headerStart = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }

  return out;
}

/** Replace each `<style>...</style>` block in HTML via `replacer`. */
export function replaceStyleBlocks(html: string, replacer: (block: StyleBlock) => string): string {
  const blocks = findStyleBlocks(html);
  if (blocks.length === 0) return html;
  const parts: string[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.start > cursor) parts.push(html.slice(cursor, block.start));
    parts.push(replacer(block));
    cursor = block.end;
  }
  if (cursor < html.length) parts.push(html.slice(cursor));
  return parts.join('');
}

/** Split CSS declaration list by top-level semicolons outside strings and `(...)` expressions. */
export function splitCssStatements(body: string): string[] {
  const statements: string[] = [];
  let quote: '\'' | '"' | null = null;
  let parenDepth = 0;
  let chunkStart = 0;
  let i = 0;

  while (i < body.length) {
    const ch = body[i];
    if (quote !== null) {
      const step = advanceCssString(body, i, quote);
      i = step.nextIndex;
      quote = step.nextQuote;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '(') {
      parenDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth -= 1;
      i += 1;
      continue;
    }
    if (ch === ';' && parenDepth === 0) {
      statements.push(body.slice(chunkStart, i));
      chunkStart = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }

  if (chunkStart < body.length) {
    statements.push(body.slice(chunkStart));
  }
  return statements;
}

/** Parse CSS declarations (`prop: value`), skipping `--*` custom properties and optionally stripping `!important`. */
export function parseCssDeclarations(
  body: string,
  options?: ParseCssDeclarationsOptions,
): CssDeclaration[] {
  const out: CssDeclaration[] = [];
  const stripImportant = options?.stripImportant === true;
  for (const raw of splitCssStatements(body)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const prop = trimmed.slice(0, colon).trim().toLowerCase();
    if (!prop || prop.startsWith('--')) continue;
    let value = trimmed.slice(colon + 1).trim();
    if (stripImportant && value.includes('!')) {
      value = value.replace(IMPORTANT_SUFFIX_RE, '').trim();
    }
    if (!value) continue;
    out.push({ prop, value });
  }
  return out;
}

/** Return the final winning declaration matching one property name or list of property names. */
export function findLastDeclaration(
  decls: readonly CssDeclaration[],
  propOrProps: string | readonly string[],
): CssDeclaration | undefined {
  if (typeof propOrProps === 'string') {
    const target = propOrProps.toLowerCase();
    for (let i = decls.length - 1; i >= 0; i -= 1) {
      const decl = decls[i];
      if (decl && decl.prop === target) return decl;
    }
    return undefined;
  }

  const targets = new Set(propOrProps.map((p) => p.toLowerCase()));
  for (let i = decls.length - 1; i >= 0; i -= 1) {
    const decl = decls[i];
    if (decl && targets.has(decl.prop)) return decl;
  }
  return undefined;
}
