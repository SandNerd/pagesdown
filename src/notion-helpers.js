import * as p from '@clack/prompts';

export function extractTitle(page) {
  if (!page) return 'Untitled';

  const toPlainText = (value) => {
    if (!Array.isArray(value)) return '';
    return value
      .map((t) => t?.plain_text || t?.text?.content || '')
      .join('')
      .trim();
  };

  const seen = new Set();
  const findTitleArray = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);

    if (Array.isArray(value)) {
      const text = toPlainText(value);
      if (text) return text;
    }

    if (typeof value.plain_text === 'string' && value.plain_text.trim()) {
      return value.plain_text.trim();
    }

    if (Array.isArray(value.title)) {
      const text = toPlainText(value.title);
      if (text) return text;
    }

    if (value.type === 'title' && Array.isArray(value.title)) {
      const text = toPlainText(value.title);
      if (text) return text;
    }

    for (const child of Object.values(value)) {
      const text = findTitleArray(child);
      if (text) return text;
    }

    return '';
  };

  const directTitle = toPlainText(page.title);
  if (directTitle) return directTitle;

  if (page.properties && typeof page.properties === 'object') {
    for (const key of Object.keys(page.properties)) {
      const prop = page.properties[key];
      if (prop && prop.type === 'title') {
        const text = findTitleArray(prop.title) || findTitleArray(prop);
        if (text) {
          try { if (process.env.PAGESDOWN_DEBUG) p.log.info(`[pagesdown] extractTitle: using property '${key}' as title`); } catch {}
          return text;
        }
      }
    }
  }

  const fallbackTitle = findTitleArray(page);
  if (fallbackTitle) {
    try { if (process.env.PAGESDOWN_DEBUG) p.log.info('[pagesdown] extractTitle: using fallback scan to locate title'); } catch {}
    return fallbackTitle;
  }

  const rawUrl = typeof page.url === 'string' ? page.url : typeof page.public_url === 'string' ? page.public_url : '';
  if (rawUrl) {
    try {
      const pathname = new URL(rawUrl).pathname;
      const lastSegment = pathname.split('/').filter(Boolean).pop() || '';
      const slug = lastSegment.replace(/-[a-f0-9]{32}$/i, '');
      const decoded = decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim();
      if (decoded) {
        try { if (process.env.PAGESDOWN_DEBUG) p.log.info('[pagesdown] extractTitle: derived title from URL slug'); } catch {}
        return decoded;
      }
    } catch {}
  }

  const idFallback = page?.id || page?.page_id || page?.database_id || page?.parent?.page_id || page?.parent?.database_id;
  if (idFallback) return idFallback;

  return 'Untitled';
}

export function extractDatabaseTitle(db) {
  if (db?.title && db.title.length > 0) {
    return db.title.map((t) => t.plain_text).join('');
  }
  return db?.id || 'Untitled Database';
}
