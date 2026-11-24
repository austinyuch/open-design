import { describe, expect, it } from 'vitest';

import {
  IMPORTANT_SUFFIX_RE,
  ROOT_FONT_PX,
  findLastDeclaration,
  findStyleBlocks,
  parseCssDeclarations,
  replaceStyleBlocks,
  sanitizeLintText,
  scanCssLeafRules,
  scanHtmlDocument,
  splitCssStatements,
  stripCssComments,
  stripHtmlComments,
  stripHtmlTagBlocks,
} from '../../src/artifacts/lint-css-utils.js';

describe('lint-css-utils', () => {
  it('exposes ROOT_FONT_PX = 16 and IMPORTANT_SUFFIX_RE', () => {
    expect(ROOT_FONT_PX).toBe(16);
    expect('red !important'.replace(IMPORTANT_SUFFIX_RE, '')).toBe('red');
    expect('red !  IMPORTANT '.replace(/\s+$/, '').replace(IMPORTANT_SUFFIX_RE, '')).toBe('red');
  });

  it('strips CSS comments linearly while respecting escaped strings and newline recovery', () => {
    expect(stripCssComments('a:1;/* c */b:2;')).toBe('a:1; b:2;');
    expect(stripCssComments('color:red/* gap */blue;')).toBe('color:red blue;');

    const withQuoted = 'content: "/* not a comment */"; /* real comment */ color: #111;';
    expect(stripCssComments(withQuoted)).toBe('content: "/* not a comment */";   color: #111;');

    const withEscapedQuote = 'content: "a \\" /* keep */ b"; /* strip */ color: #222;';
    expect(stripCssComments(withEscapedQuote)).toBe('content: "a \\" /* keep */ b";   color: #222;');

    const brokenString = 'content: "unclosed\n/* real comment */ color: #333;';
    expect(stripCssComments(brokenString)).toBe('content: "unclosed\n  color: #333;');

    expect(stripCssComments('color: #111; /* unterminated')).toBe('color: #111;  ');
  });

  it('finds and replaces <style> blocks without backtracking or matching <stylesheet>', () => {
    const html = [
      '\u0130\u0130\u0130',
      '<link rel="stylesheet" href="a.css"><stylesheet>body{}</stylesheet>',
      '<script>const s = "<style>.fake{color:red}</style>";</script>',
      '<template><style>.tpl{color:red}</style></template>',
      '<STYLE media="screen" data-note="x>y">h1{color:red}</StYlE>',
      '<div data-x="1">hello</div>',
      '<style>.x::before{content:"<script>"} p{color:blue}</style>',
      '<style>unclosed',
    ].join('');

    const blocks = findStyleBlocks(html);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.open).toBe('<STYLE media="screen" data-note="x>y">');
    expect(blocks[0]?.css).toBe('h1{color:red}');
    expect(blocks[0]?.close).toBe('</StYlE>');
    expect(blocks[1]?.css).toBe('.x::before{content:"<script>"} p{color:blue}');

    const stripped = replaceStyleBlocks(html, () => '');
    expect(stripped).toBe(
      '\u0130\u0130\u0130<link rel="stylesheet" href="a.css"><stylesheet>body{}</stylesheet><script>const s = "<style>.fake{color:red}</style>";</script><template><style>.tpl{color:red}</style></template><div data-x="1">hello</div><style>unclosed',
    );

    const upper = replaceStyleBlocks(html, (b) => `${b.open}${b.css.toUpperCase()}${b.close}`);
    expect(upper).toContain('<STYLE media="screen" data-note="x>y">H1{COLOR:RED}</StYlE>');
    expect(upper).toContain('<style>.X::BEFORE{CONTENT:"<SCRIPT>"} P{COLOR:BLUE}</style>');
  });

  it('strips non-rendered HTML tag blocks with Turkish uppercase offsets and quoted > attributes', () => {
    const html =
      '\u0130\u0130<script data-x="a>b">const x = 1;</script><p>keep</p><template><span>drop</span></template>';
    expect(stripHtmlTagBlocks(html, ['script', 'template'])).toBe('\u0130\u0130<p>keep</p>');
  });

  it('splits CSS statements ignoring semicolons inside quotes, unquoted parens, escapes, and broken lines', () => {
    const body = [
      'background-image: url(data:image/svg+xml;utf8,<svg/>);',
      'background: url("data:image/svg+xml;utf8,<svg/>");',
      'content: "x \\"; y";',
      'content: "unclosed\n; color: red;',
      'opacity: 0.9',
    ].join('');

    expect(splitCssStatements(body)).toEqual([
      'background-image: url(data:image/svg+xml;utf8,<svg/>)',
      'background: url("data:image/svg+xml;utf8,<svg/>")',
      'content: "x \\"; y"',
      'content: "unclosed\n',
      ' color: red',
      'opacity: 0.9',
    ]);
  });

  it('scans leaf CSS rules past @import statements, quoted braces, and wrapper blocks', () => {
    const css = [
      "@import url('https://example.com/a;b.css');",
      ':root { --fg: #111; }',
      '.q { content: "{not-nested}"; letter-spacing: 0.02em; }',
      '@media (prefers-color-scheme: dark) { :root { --accent: #6366f1; } }',
    ].join('\n');

    expect(scanCssLeafRules(css)).toEqual([
      {
        start: css.indexOf('\n:root'),
        end: css.indexOf('\n.q'),
        selector: ':root',
        body: ' --fg: #111; ',
      },
      {
        start: css.indexOf('\n.q'),
        end: css.indexOf('\n@media'),
        selector: '.q',
        body: ' content: "{not-nested}"; letter-spacing: 0.02em; ',
      },
      {
        start: css.indexOf(' :root { --accent'),
        end: css.indexOf('--accent: #6366f1; }') + '--accent: #6366f1; }'.length,
        selector: ':root',
        body: ' --accent: #6366f1; ',
      },
    ]);
    expect(() => scanCssLeafRules('{'.repeat(5000))).not.toThrow();
    expect(sanitizeLintText('a\u001b[31mb\nc\td', 12)).toBe('a b c d');
  });

  it('parses CSS declarations skipping --* by default and toggling !important stripping', () => {
    const css = `
      --letter-spacing: 0.08em !important;
      letter-spacing: 0.04em ! important;
      COLOR: #123456 !IMPORTANT;
      border-color: rgb(0, 0, 0);
    `;

    expect(parseCssDeclarations(css)).toEqual([
      { prop: 'letter-spacing', value: '0.04em ! important' },
      { prop: 'color', value: '#123456 !IMPORTANT' },
      { prop: 'border-color', value: 'rgb(0, 0, 0)' },
    ]);

    expect(parseCssDeclarations(css, { stripImportant: true })).toEqual([
      { prop: 'letter-spacing', value: '0.04em' },
      { prop: 'color', value: '#123456' },
      { prop: 'border-color', value: 'rgb(0, 0, 0)' },
    ]);

    const decls = parseCssDeclarations('border: 1px solid #111; border-color: #222; background: #fff;');
    expect(findLastDeclaration(decls, 'BACKGROUND')).toEqual({ prop: 'background', value: '#fff' });
    expect(findLastDeclaration(decls, ['border', 'border-color'])).toEqual({
      prop: 'border-color',
      value: '#222',
    });
    expect(findLastDeclaration(decls, 'font-size')).toBeUndefined();
  });

  it('strips HTML comments respecting script/style rawtext boundaries, abrupt endings, and style offsets', () => {
    const htmlWithCommentedStyle =
      '<!-- <style>a{color:red}</style> --><!-->--!><script>const x = "<!--";</script><style>b{color:blue}</style>';
    const blocks = findStyleBlocks(htmlWithCommentedStyle);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.css).toBe('b{color:blue}');

    const replaced = replaceStyleBlocks(htmlWithCommentedStyle, (b) => `${b.open}${b.css.toUpperCase()}${b.close}`);
    expect(replaced).toBe(
      '<!-- <style>a{color:red}</style> --><!-->--!><script>const x = "<!--";</script><style>B{COLOR:BLUE}</style>',
    );

    const stripped = stripHtmlComments('<script>const x = "<!--";</script><main><p>ok</p></main><!-- end -->');
    expect(stripped).toBe('<script>const x = "<!--";</script><main><p>ok</p></main>');
    expect(stripHtmlComments('<svg><![CDATA[ <!-- ]]></svg><button></button>')).toBe(
      '<svg><![CDATA[ <!-- ]]></svg><button></button>',
    );
    expect(stripHtmlComments('<?xml <!-- ?><button></button>')).toBe('<?xml <!-- ?><button></button>');
    expect(() => stripHtmlComments('<!-- '.repeat(20_000))).not.toThrow();
  });

  it('scans HTML documents linearly preserving <title>, stripping non-rendered/svg blocks, and guarding UTF-16 surrogates', () => {
    const html = [
      '\u0130',
      '<html lang="en" data-note="lang=\'fr\'">',
      '<head>',
      '<!-- <style>.ignored{color:red}</style> -->',
      '<svg/><svg id="ico"><svg></svg><title>Icon</title></svg>',
      '<title>My Title</title>',
      '<textarea><img src="ignored.png"></textarea>',
      '<iframe><img src="ignored2.png"></iframe>',
      '<noscript><img src="ignored3.png"></noscript>',
      '<style>.ok{color:#111}</style>',
      '<script>const x = "<!-- <img src=a>";</script>',
      '</head>',
      '<body>',
      '<button title="a > b" style="width:10px;height:10px">Save</button>',
      '<img id="hero" title=" alt " alt="a > b" />',
      '</body></html>',
    ].join('');

    const doc = scanHtmlDocument(html);
    expect(doc.styleBlocks).toHaveLength(1);
    expect(doc.styleBlocks[0]?.css).toBe('.ok{color:#111}');
    expect(doc.documentMarkupWithoutSvg).toContain('<title>My Title</title>');
    expect(doc.documentMarkupWithoutSvg).not.toContain('Icon');
    expect(doc.documentMarkupWithoutSvg).not.toContain('ignored.png');
    expect(doc.documentMarkupWithoutSvg).not.toContain('ignored2.png');
    expect(doc.documentMarkupWithoutSvg).not.toContain('ignored3.png');
    expect(doc.elementIds.has('ico')).toBe(true);
    expect(doc.elementIds.has('hero')).toBe(true);
    expect(doc.inlineStyleTags).toHaveLength(1);
    expect(doc.inlineStyleTags[0]?.tagName).toBe('button');
    expect(doc.inlineStyleTags[0]?.attrs.get('style')).toBe('width:10px;height:10px');

    const imgTags = doc.tags.filter((t) => !t.isClose && t.tagName === 'img');
    expect(imgTags).toHaveLength(1);
    const imgOpen = imgTags[0];
    expect(imgOpen?.selfClosing).toBe(true);
    expect(imgOpen?.attrs.get('title')).toBe(' alt ');
    expect(imgOpen?.attrs.get('alt')).toBe('a > b');

    // UTF-16 surrogate safety on sanitizeLintText truncation
    const emojiText = `${'a'.repeat(18)}\u{1F680}end`;
    const clipped = sanitizeLintText(emojiText, 20);
    expect(clipped).toBe(`${'a'.repeat(18)}…`);
    expect(clipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
