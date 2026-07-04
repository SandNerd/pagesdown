import path from 'node:path';

const SCRIPT_LANGUAGE_BY_EXTENSION = {
  '.bash': 'bash',
  '.cjs': 'javascript',
  '.css': 'css',
  '.go': 'go',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.lua': 'lua',
  '.mjs': 'javascript',
  '.php': 'php',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.sh': 'bash',
  '.sql': 'sql',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

function getCodeLanguage(filename) {
  if (!filename || typeof filename !== 'string') {
    return null;
  }

  const ext = path.extname(filename).toLowerCase();
  return SCRIPT_LANGUAGE_BY_EXTENSION[ext] || null;
}

const NOTION_RICH_TEXT_MAX = 2000;

function isValidHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function splitIntoChunksPreservingLines(text, maxLen = NOTION_RICH_TEXT_MAX) {
  if (!text || text.length <= maxLen) return [text];
  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const next = current ? current + '\n' + line : line;
    if (next.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = line;
        if (current.length > maxLen) {
          let start = 0;
          while (start < current.length) {
            chunks.push(current.slice(start, start + maxLen));
            start += maxLen;
          }
          current = '';
        }
      } else {
        let start = 0;
        while (start < line.length) {
          chunks.push(line.slice(start, start + maxLen));
          start += maxLen;
        }
        current = '';
      }
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function makeTextObjects(content, annotations = {}, link = null) {
  if (content === undefined || content === null) return [];
  const chunks = splitIntoChunksPreservingLines(String(content));
  const objs = [];
  for (const chunk of chunks) {
    if (chunk === '') continue;
    const obj = {
      type: 'text',
      text: {
        content: chunk,
        link: link ? { url: link } : null,
      },
    };
    if (annotations && Object.keys(annotations).length) obj.annotations = annotations;
    objs.push(obj);
  }
  return objs;
}

function parseMarkdownToRichText(text) {
  if (!text) return [];

  // Tokenize bold (**text**), inline code (`text`), and markdown links ([text](url))
  const tokenRegex = /(\*\*.*?\*\*|`.*?`|\[.*?\]\(.*?\))/g;
  const parts = text.split(tokenRegex);
  const result = [];

  for (const part of parts) {
    if (!part) continue;

    if (part.startsWith('**') && part.endsWith('**')) {
      const content = part.slice(2, -2);
      result.push(...makeTextObjects(content, { bold: true }, null));
      continue;
    }

    if (part.startsWith('`') && part.endsWith('`')) {
      const content = part.slice(1, -1);
      result.push(...makeTextObjects(content, { code: true }, null));
      continue;
    }

    if (part.startsWith('[') && part.includes('](')) {
      const match = part.match(/\[(.*?)\]\((.*?)\)/);
      if (match) {
        const label = match[1];
        const url = match[2];
        const sanitized = isValidHttpUrl(url) ? url : null;
        if (sanitized) {
          result.push(...makeTextObjects(label, {}, sanitized));
        } else {
          // If URL isn't valid for Notion, keep the label as plain text and include the raw URL in parentheses.
          result.push(...makeTextObjects(`${label} (${url})`, {}, null));
        }
        continue;
      }
    }

    result.push(...makeTextObjects(part, {}, null));
  }

  return result.filter((p) => p && p.text && p.text.content !== '');
}

function createCodeBlock(codeText, language) {
  const rich_text = makeTextObjects(codeText, {}, null);
  return {
    object: 'block',
    type: 'code',
    code: {
      rich_text,
      language,
      caption: [],
    },
  };
}

function createTextObject(content) {
  return {
    type: 'text',
    text: {
      content,
      link: null,
    },
  };
}

function createParagraphBlock(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: parseMarkdownToRichText(text),
    },
  };
}

function createHeadingBlock(level, text) {
  return {
    object: 'block',
    type: `heading_${level}`,
    [`heading_${level}`]: {
      rich_text: parseMarkdownToRichText(text),
      is_toggleable: false,
    },
  };
}

function createListBlock(type, text) {
  return {
    object: 'block',
    type,
    [type]: {
      rich_text: parseMarkdownToRichText(text),
    },
  };
}

function createDividerBlock() {
  return {
    object: 'block',
    type: 'divider',
    divider: {},
  };
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableSeparatorRow(line, expectedColumns) {
  const cells = splitTableRow(line);
  if (cells.length !== expectedColumns) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function createTableBlock(rows) {
  const [headerRow, ...dataRows] = rows;
  const columnCount = headerRow.length;

  return {
    object: 'block',
    type: 'table',
    table: {
      table_width: columnCount,
      has_column_header: true,
      has_row_header: false,
      children: [headerRow, ...dataRows].map((cells) => ({
        object: 'block',
        type: 'table_row',
        table_row: {
          cells: cells.map((text) => parseMarkdownToRichText(text)),
        },
      })),
    },
  };
}

function parseTableBlock(lines, startIndex) {
  const tableLines = [];
  let index = startIndex;

  while (index < lines.length && lines[index].trim().startsWith('|')) {
    tableLines.push(lines[index]);
    index++;
  }

  if (tableLines.length < 2) {
    return null;
  }

  const headerRow = splitTableRow(tableLines[0]);
  if (headerRow.length === 0) {
    return null;
  }

  if (!isTableSeparatorRow(tableLines[1], headerRow.length)) {
    return null;
  }

  const dataRows = [];
  for (let rowIndex = 2; rowIndex < tableLines.length; rowIndex++) {
    const cells = splitTableRow(tableLines[rowIndex]);
    if (cells.length === 0) continue;
    while (cells.length < headerRow.length) cells.push('');
    dataRows.push(cells.slice(0, headerRow.length));
  }

  return {
    block: createTableBlock([headerRow, ...dataRows]),
    nextIndex: index,
  };
}

/**
 * Convert Markdown text to Notion JSON block structures.
 * Returns an array of Notion block objects.
 */
export function markdownToNotionBlocks(markdownText, filename) {
  if (typeof markdownText !== 'string') {
    return [];
  }

  const scriptLanguage = getCodeLanguage(filename);
  if (scriptLanguage) {
    return [createCodeBlock(markdownText, scriptLanguage)];
  }

  if (!markdownText) {
    return [];
  }

  const lines = markdownText.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Early exclusion rule for layout noise and structural anomalies
    if (/^<\/?aside>/i.test(trimmed) || /^---+\|$/.test(trimmed)) {
      i++;
      continue;
    }

    // Skip empty lines at the top level (they'll be handled within blocks)
    if (!trimmed) {
      i++;
      continue;
    }

    if (/^---+$|^\*\*\*+$/.test(trimmed)) {
      blocks.push(createDividerBlock());
      i++;
      continue;
    }

    if (trimmed.startsWith('|')) {
      const parsedTable = parseTableBlock(lines, i);
      if (parsedTable) {
        blocks.push(parsedTable.block);
        i = parsedTable.nextIndex;
        continue;
      }
    }

    // Heading 1: # Heading
    if (trimmed.startsWith('# ')) {
      const text = trimmed.slice(2).trim();
      if (text) {
        blocks.push(createHeadingBlock(1, text));
      }
      i++;
      continue;
    }

    // Heading 2: ## Heading
    if (trimmed.startsWith('## ')) {
      const text = trimmed.slice(3).trim();
      if (text) {
        blocks.push(createHeadingBlock(2, text));
      }
      i++;
      continue;
    }

    // Heading 3: ### Heading
    if (trimmed.startsWith('### ')) {
      const text = trimmed.slice(4).trim();
      if (text) {
        blocks.push(createHeadingBlock(3, text));
      }
      i++;
      continue;
    }

    // Fenced code block: ```language ... ```
    if (trimmed.startsWith('```')) {
      const languageLine = trimmed.slice(3).trim();
      const language = languageLine || 'javascript';
      const codeLines = [];
      i++;

      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }

      if (i < lines.length && lines[i].trim().startsWith('```')) {
        i++;
      }

      const codeText = codeLines.join('\n').trimEnd();
      if (codeText) {
        blocks.push(createCodeBlock(codeText, language));
      }
      continue;
    }

    // Numbered list: 1. Item
    if (/^\d+\.\s+/.test(trimmed)) {
      const text = trimmed.replace(/^\d+\.\s+/, '').trim();
      if (text) {
        blocks.push(createListBlock('numbered_list_item', text));
      }
      i++;
      continue;
    }

    // Bulleted list: - Item or * Item (with checkbox support)
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const text = trimmed.replace(/^[-*]\s+/, '').trim();
      if (text) {
        // Check for checkbox: [ ], [], [x], [X]
        if (/^\[\s*x?\s*\]/i.test(text)) {
          const checked = /^\[\s*x\s*\]/i.test(text);
          const cleanedText = text.replace(/^\[\s*x?\s*\]\s*/i, '').trim();
          blocks.push({
            object: 'block',
            type: 'to_do',
            to_do: {
              rich_text: parseMarkdownToRichText(cleanedText),
              checked,
            },
          });
        } else {
          blocks.push(createListBlock('bulleted_list_item', text));
        }
      }
      i++;
      continue;
    }

    // Default: paragraph
    if (trimmed) {
      blocks.push(createParagraphBlock(trimmed));
    }

    i++;
  }

  return blocks;
}
