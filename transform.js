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
  
  // Step 7: Remove elements that don't work in email
  article.find('script').remove();
  article.find('noscript').remove();
  article.find('iframe').remove();
  article.find('video').remove();
  article.find('audio').remove();
  
  // Step 8: Remove SVGs (replace with alt text or remove)
  article.find('svg').each((i, el) => {
    $(el).remove();
  });
  
  // Step 9: Clean up any remaining class attributes (optional, keeps HTML cleaner)
  // We keep them for now in case some email clients use them
  
  // Step 10: Get hero image
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
