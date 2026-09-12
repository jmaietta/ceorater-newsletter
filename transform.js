/**
 * HTML Transformation Engine
 * Converts web HTML articles to email-compatible format
 * 
 * Uses 'juice' library to inline CSS from <style> blocks
 */

const cheerio = require('cheerio');
const juice = require('juice');

const BASE_URL = 'https://www.ceorater.com';

/**
 * Transform web article HTML to email-safe HTML
 * @param {string} html - Raw HTML from the web article
 * @param {string} articlePath - Path like "news/article.html"
 * @returns {object} - { title, content, heroImage }
 */
function transformArticle(html, articlePath) {
  
  // Step 1: Extract title before any processing
  let $ = cheerio.load(html);
  let title = $('title').text().trim();
  title = title.replace(/\s*\|\s*CEORater\s*$/, '');
  
  // Step 2: Use juice to inline ALL CSS from <style> blocks
  // This handles all your custom classes like .key-insight, .highlight-box, etc.
  const inlinedHtml = juice(html, {
    removeStyleTags: true,
    preserveMediaQueries: false,
    preserveFontFaces: false,
    applyStyleTags: true,
    applyAttributesTableElements: true
  });
  
  // Step 3: Parse the inlined HTML
  $ = cheerio.load(inlinedHtml);
  
  // Step 4: Extract article content
  const article = $('article');
  if (!article.length) {
    throw new Error('No <article> tag found in HTML');
  }
  
  // Get the article directory for resolving relative URLs
  const articleDir = articlePath.substring(0, articlePath.lastIndexOf('/'));
  
  // Step 5: Fix image URLs (relative → absolute) and add email-safe styling
  article.find('img').each((i, el) => {
    const src = $(el).attr('src');
    if (src && !src.startsWith('http')) {
      const absoluteSrc = resolveUrl(src, articleDir);
      $(el).attr('src', absoluteSrc);
    }
    
    // Ensure images are responsive in email
    const existingStyle = $(el).attr('style') || '';
    if (!existingStyle.includes('max-width')) {
      $(el).attr('style', existingStyle + ' max-width: 100%; height: auto;');
    }
  });
  
  // Step 6: Fix link URLs (relative → absolute)
  article.find('a').each((i, el) => {
    const href = $(el).attr('href');
    if (href && !href.startsWith('http') && !href.startsWith('mailto:') && !href.startsWith('#')) {
      const absoluteHref = resolveUrl(href, articleDir);
      $(el).attr('href', absoluteHref);
    }
  });
  
  // Step 7: Convert YouTube iframes to email-safe clickable thumbnails
  article.find('iframe').each((i, el) => {
    const src = $(el).attr('src') || '';
    const match = src.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]+)/);
    if (match) {
      const videoId = match[1];
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const thumbUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
      const fallback = `
        <div style="margin: 24px 0; text-align: center;">
          <a href="${watchUrl}" target="_blank" style="text-decoration: none; display: inline-block;">
            <img src="${thumbUrl}" alt="Watch video" style="width: 100%; max-width: 600px; border-radius: 8px; display: block;" />
          </a>
          <div style="margin-top: 12px;">
            <a href="${watchUrl}" target="_blank" style="display: inline-block; background-color: #dc2626; color: #ffffff; font-weight: 600; font-size: 15px; padding: 10px 24px; border-radius: 6px; text-decoration: none;">&#9654; Watch on YouTube</a>
          </div>
        </div>`;
      $(el).parent().length ? $(el).replaceWith(fallback) : $(el).replaceWith(fallback);
    }
  });

  // Step 8: Remove remaining elements that don't work in email
  article.find('script').remove();
  article.find('noscript').remove();
  article.find('iframe').remove();
  article.find('video').remove();
  article.find('audio').remove();
  
  // Step 9: Remove SVGs (replace with alt text or remove)
  article.find('svg').each((i, el) => {
    $(el).remove();
  });
  
  // Step 9b: Put the article on an email palette.
  //
  // juice() above inlines every rule from the page, and ceorater.com is a dark
  // theme: finance-fix sets `h1,h2,h3,h4,h5 { color:#fff !important }`, body
  // text to #e8e6df, panels to near-black. Those land inside the white content
  // cell in email-template.html -- white text on white, and the headings vanish.
  //
  // Setting a colour on the container cannot fix it, because each element now
  // carries its own inline `color` that wins. The styles have to be rewritten
  // on the elements themselves.
  //
  // Colour is remapped rather than stripped: amber section headers and the
  // green/red of a positive or negative return carry meaning. Only values that
  // assume a black background are changed.
  const DARK_TO_EMAIL = [
    [/^#fff(fff)?$/i, '#1a1a1a'],
    [/^#e8e6df$/i, '#1a1a1a'],
    [/^#8a8878$/i, '#6b7280'],
    [/^#9a9788$/i, '#6b7280'],
    [/^#b9b6aa$/i, '#4b5563'],
    [/^#ff9f1c$/i, '#b45309'],   // amber on white is ~1.9:1, unreadable
    [/^#b97a14$/i, '#92400e'],
    [/^#fbbf24$/i, '#b45309'],
    [/^#2fd47f$/i, '#047857'],
    [/^#ff4d42$/i, '#b91c1c'],
    [/^#38c8d8$/i, '#0e7490'],
  ];
  const DARK_BACKGROUNDS = /^#(000|000000|070705|0c0c09|14130b|1a1408)$/i;
  const DARK_BORDERS = /^#(1c1b14|2a291f|3a382e|36342b)$/i;

  // .code-block is a dark panel with light text by design and reads correctly
  // in email as-is, so it is left alone.
  const inCodeBlock = (el) => $(el).closest('pre, code, .code-block').length > 0;

  const remap = (value, table) => {
    for (const [pattern, replacement] of table) {
      if (pattern.test(value)) return replacement;
    }
    return null;
  };

  article.find('*').each((i, el) => {
    if (inCodeBlock(el)) return;
    const style = $(el).attr('style');
    if (!style) return;

    const rewritten = style.split(';').map((decl) => {
      const idx = decl.indexOf(':');
      if (idx === -1) return decl;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      const val = decl.slice(idx + 1).trim();
      const bang = /!important$/i.test(val);
      const bare = val.replace(/!important$/i, '').trim();

      let next = null;
      if (prop === 'color') {
        next = remap(bare, DARK_TO_EMAIL);
      } else if (prop === 'background' || prop === 'background-color') {
        if (DARK_BACKGROUNDS.test(bare)) next = '#f9fafb';
      } else if (prop.indexOf('border') === 0 && DARK_BORDERS.test(bare)) {
        next = '#e5e7eb';
      }
      if (next === null) return decl;
      return ' ' + prop + ': ' + next + (bang ? ' !important' : '');
    }).join(';');

    $(el).attr('style', rewritten);
  });

  // Backstop: a heading that arrived with no colour of its own must read as
  // black rather than whatever the client decides.
  article.find('h1, h2, h3, h4, h5, h6').each((i, el) => {
    const style = $(el).attr('style') || '';
    if (!/(^|;)\s*color\s*:/i.test(style)) {
      $(el).attr('style', (style + ';color:#1a1a1a').replace(/^;/, ''));
    }
  });

  // Step 10: Clean up any remaining class attributes (optional, keeps HTML cleaner)
  // We keep them for now in case some email clients use them
  
  // Step 11: Get hero image
  const heroImg = article.find('img').first();
  const heroImage = heroImg.length ? heroImg.attr('src') : null;
  
  // Get the final content
  const content = article.html();
  
  return {
    title,
    content,
    heroImage
  };
}

/**
 * Resolve relative URL to absolute
 */
function resolveUrl(url, articleDir) {
  if (url.startsWith('http')) return url;
  
  // Handle ../ prefix (going up directories)
  let path = url;
  let dir = articleDir;
  
  while (path.startsWith('../')) {
    path = path.substring(3); // Remove ../
    dir = dir.substring(0, dir.lastIndexOf('/')); // Go up one directory
  }
  
  // Handle ./ prefix
  if (path.startsWith('./')) {
    path = path.substring(2);
  }
  
  // Build absolute URL
  if (dir) {
    return `${BASE_URL}/${dir}/${path}`.replace(/\/+/g, '/').replace(':/', '://');
  } else {
    return `${BASE_URL}/${path}`.replace(/\/+/g, '/').replace(':/', '://');
  }
}

/**
 * Extract subject line from title
 */
function extractSubject(title) {
  return title.replace(/\s*\|\s*CEORater\s*$/, '').trim();
}

module.exports = {
  transformArticle,
  extractSubject,
  resolveUrl
};
