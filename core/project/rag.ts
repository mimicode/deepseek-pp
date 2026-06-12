import type { ProjectFile, ProjectRagChunk } from './types';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'at', 'by',
  'for', 'with', 'about', 'against', 'is', 'it', 'was', 'were', 'are', 'be',
  'been', 'to', 'from', 'in', 'out', 'on', 'off', 'over', 'under', 'how', 'what',
  'where', 'why', 'who', 'which', 'this', 'that', 'these', 'those',
]);

export function tokenizeProjectText(text: string): string[] {
  const tokens: string[] = [];
  // Match Latin/digit runs and CJK runs separately so a string mixing both
  // splits into distinct tokens instead of one opaque token.
  const matches = text.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]+/gi) ?? [];
  for (const match of matches) {
    if (/[\u4e00-\u9fff]/.test(match)) {
      // CJK has no whitespace word boundaries; emit overlapping bigrams (with a
      // unigram fallback for a lone character) so Chinese queries can retrieve
      // Chinese content rather than only matching identical character runs.
      if (match.length === 1) {
        tokens.push(match);
        continue;
      }
      for (let i = 0; i < match.length - 1; i += 1) {
        tokens.push(match.slice(i, i + 2));
      }
    } else if (match.length >= 2 && !STOP_WORDS.has(match)) {
      tokens.push(match);
    }
  }
  return tokens;
}

export function chunkProjectFile(
  file: Pick<ProjectFile, 'id' | 'path' | 'content'>,
  chunkSize = 900,
  overlapLines = 4,
): ProjectRagChunk[] {
  const lines = file.content.split(/\r?\n/);
  const chunks: ProjectRagChunk[] = [];
  let index = 0;
  while (index < lines.length) {
    const startLine = index + 1;
    const selected: string[] = [];
    let chars = 0;
    while (index < lines.length && (chars < chunkSize || selected.length < 3)) {
      const line = lines[index] ?? '';
      selected.push(line);
      chars += line.length + 1;
      index += 1;
    }
    chunks.push({
      fileId: file.id,
      filePath: file.path,
      content: selected.join('\n'),
      startLine,
      endLine: index,
      score: 0,
    });
    if (index >= lines.length) break;
    index = Math.max(startLine, index - overlapLines);
  }
  return chunks;
}

export function searchProjectFiles(
  query: string,
  files: readonly ProjectFile[],
  limit = 6,
): ProjectRagChunk[] {
  const queryTokens = tokenizeProjectText(query);
  if (queryTokens.length === 0 || files.length === 0) return [];

  const chunks = files.flatMap((file) => chunkProjectFile(file));
  if (chunks.length === 0) return [];

  const tokenLists = chunks.map((chunk) => tokenizeProjectText(`${chunk.filePath}\n${chunk.content}`));
  const averageLength = tokenLists.reduce((sum, tokens) => sum + tokens.length, 0) / tokenLists.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const token of queryTokens) {
    documentFrequency.set(token, tokenLists.filter((tokens) => tokens.includes(token)).length);
  }

  return chunks
    .map((chunk, index) => {
      const tokens = tokenLists[index] ?? [];
      const frequencies = new Map<string, number>();
      for (const token of tokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }
      let score = 0;
      for (const token of queryTokens) {
        const freq = frequencies.get(token) ?? 0;
        if (freq === 0) continue;
        const df = documentFrequency.get(token) ?? 0;
        const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
        const k1 = 1.2;
        const b = 0.75;
        score += idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (tokens.length / averageLength)));
        if (chunk.filePath.toLowerCase().includes(token)) score += 8;
      }
      return { ...chunk, score };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

export function formatProjectPromptContext(input: {
  projectName: string;
  instructions?: string;
  chunks: readonly ProjectRagChunk[];
}): string {
  if (input.chunks.length === 0 && !input.instructions?.trim()) return '';
  const lines = [
    '## Project Context',
    `Project: ${input.projectName}`,
  ];
  if (input.instructions?.trim()) {
    lines.push('', 'Project instructions:', input.instructions.trim());
  }
  if (input.chunks.length > 0) {
    lines.push('', 'Relevant files:');
    for (const chunk of input.chunks) {
      lines.push(
        `\n--- ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} ---`,
        '```',
        chunk.content,
        '```',
      );
    }
  }
  return lines.join('\n');
}
