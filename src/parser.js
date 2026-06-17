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

function parseMarkdownToRichText(text) {
  if (!text) return [];

  // Tokenize bold formatting (**text**), inline code highlights (`text`), and markdown hyperlinks ([text](url))
  const tokenRegex = /(\*\*.*?\*\*|`.*?`|\[.*?\]\(.*?\))/g;
  const parts = text.split(tokenRegex);

  return parts
    .map((part) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return {
          type: 'text',
          text: { content: part.slice(2, -2) },
          annotations: { bold: true },
        };
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return {
          type: 'text',
          text: { content: part.slice(1, -1) },
          annotations: { code: true },
        };
      }
      if (part.startsWith('[') && part.includes('](')) {
        const match = part.match(/\[(.*?)\]\((.*?)\)/);
        if (match) {
          return {
            type: 'text',
            text: { content: match[1], link: { url: match[2] } },
          };
        }
      }
      return {
        type: 'text',
        text: { content: part },
      };
    })
    .filter((p) => p.text.content !== '');
}

function createCodeBlock(codeText, language) {
  return {
    object: 'block',
    type: 'code',
    code: {
      rich_text: [
        {
          type: 'text',
          text: {
            content: codeText,
            link: null,
          },
        },
      ],
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
        blocks.push({
          object: 'block',
          type: 'code',
          code: {
            rich_text: [
              {
                type: 'text',
                text: {
                  content: codeText,
                  link: null,
                },
              },
            ],
            language,
            caption: [],
          },
        });
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
