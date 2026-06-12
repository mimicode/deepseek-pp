import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addProjectFiles,
  createProjectContext,
  fetchGitHubProjectFiles,
  formatProjectPromptContext,
  getActiveProjectPromptContext,
  getProjectContextState,
  normalizeProjectContextState,
  normalizeProjectFiles,
  parseGitHubRepository,
  searchProjectFiles,
  setActiveProjectFiles,
} from '../core/project';
import type { ProjectContextState, ProjectFile } from '../core/project';

let storage: Record<string, unknown>;

beforeEach(() => {
  storage = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          storage = { ...storage, ...values };
        }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('project context sources and retrieval', () => {
  it('parses GitHub shorthand and tree URLs', () => {
    expect(parseGitHubRepository('owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
      ref: 'main',
      pathPrefix: '',
    });
    expect(parseGitHubRepository('https://github.com/owner/repo/tree/feature/docs')).toEqual({
      owner: 'owner',
      repo: 'repo',
      ref: 'feature',
      pathPrefix: 'docs',
    });
  });

  it('normalizes imported files with skip, text, and size boundaries', () => {
    const normalized = normalizeProjectFiles([
      { path: 'src/index.ts', content: 'export const answer = 42;' },
      { path: 'node_modules/pkg/index.ts', content: 'skip me' },
      { path: 'image.png', content: 'not text' },
      { path: 'empty.md', content: '   ' },
    ], 'local_folder');

    expect(normalized).toEqual([
      { path: 'src/index.ts', content: 'export const answer = 42;', sourceKind: 'local_folder' },
    ]);
  });

  it('fetches GitHub trees, falls back from main to master, and filters source files', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/git/trees/main')) {
        return new Response('', { status: 404 });
      }
      if (value.includes('/git/trees/master')) {
        return Response.json({
          tree: [
            { path: 'README.md', type: 'blob', size: 20 },
            { path: 'dist/bundle.js', type: 'blob', size: 20 },
            { path: 'src/app.ts', type: 'blob', size: 20 },
          ],
        });
      }
      if (value.endsWith('/README.md')) return new Response('# Repo');
      if (value.endsWith('/src/app.ts')) return new Response('export const app = true;');
      return new Response('missing', { status: 500 });
    }) as unknown as typeof fetch;

    const result = await fetchGitHubProjectFiles('owner/repo', { fetchImpl });

    expect(result.source.ref).toBe('master');
    expect(result.files.map((file) => file.path)).toEqual(['README.md', 'src/app.ts']);
    expect(result.warnings).toEqual([]);
  });

  it('resolves GitHub tree URLs whose branch name contains slashes', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/git/trees/feature/android/docs')) {
        return new Response('', { status: 404 });
      }
      if (value.includes('/git/trees/feature/android?')) {
        return Response.json({
          tree: [
            { path: 'docs/README.md', type: 'blob', size: 20 },
            { path: 'src/app.ts', type: 'blob', size: 20 },
          ],
        });
      }
      if (value.endsWith('/feature/android/docs/README.md')) return new Response('# Android docs');
      return new Response('missing', { status: 500 });
    }) as unknown as typeof fetch;

    const result = await fetchGitHubProjectFiles('https://github.com/owner/repo/tree/feature/android/docs', { fetchImpl });

    expect(result.source).toEqual({
      owner: 'owner',
      repo: 'repo',
      ref: 'feature/android',
      pathPrefix: 'docs',
    });
    expect(result.files.map((file) => file.path)).toEqual(['README.md']);
  });

  it('explains GitHub 403 failures as authentication or rate-limit issues', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limit', { status: 403 })) as unknown as typeof fetch;

    await expect(fetchGitHubProjectFiles('owner/repo', { fetchImpl })).rejects.toThrow(
      'The repository may require authentication',
    );
  });

  it('ranks relevant chunks and formats prompt context', () => {
    const files: ProjectFile[] = [
      projectFile('p1', 'docs/setup.md', 'Install Android WebView assets\nRun npm run build:android'),
      projectFile('p1', 'src/memory.ts', 'Memory save and recall helpers'),
    ];

    const chunks = searchProjectFiles('android assets', files, 2);
    const formatted = formatProjectPromptContext({
      projectName: 'DeepSeek++',
      instructions: 'Prefer project context.',
      chunks,
    });

    expect(chunks[0].filePath).toBe('docs/setup.md');
    expect(formatted).toContain('## Project Context');
    expect(formatted).toContain('Project: DeepSeek++');
    expect(formatted).toContain('--- docs/setup.md:1-2 ---');
  });

  it('retrieves Chinese content for Chinese queries via CJK bigram tokens', () => {
    const files: ProjectFile[] = [
      projectFile('p1', 'docs/config.md', '配置说明：启用记忆功能后即可保存对话。'),
      projectFile('p1', 'docs/other.md', 'Unrelated English documentation about widgets.'),
    ];

    const chunks = searchProjectFiles('如何启用记忆功能', files, 2);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].filePath).toBe('docs/config.md');
  });

  it('stores active project files and returns retrieved prompt context', async () => {
    const project = await createProjectContext({
      name: 'Plugin',
      instructions: 'Follow repo conventions.',
    });
    const files = await addProjectFiles(project.id, [
      { path: 'android/MainActivity.kt', content: 'class MainActivity : Activity()' },
      { path: 'README.md', content: 'General documentation' },
    ]);
    await setActiveProjectFiles(project.id, [files[0].id]);

    const state = await getProjectContextState();
    const context = await getActiveProjectPromptContext('MainActivity');

    expect(state.activeProjectId).toBe(project.id);
    expect(state.activeFileIds).toEqual([files[0].id]);
    expect(context?.projectName).toBe('Plugin');
    expect(context?.chunks.map((chunk) => chunk.filePath)).toEqual(['android/MainActivity.kt']);
  });

  it('normalizes stale active ids out of stored state', () => {
    const state = normalizeProjectContextState({
      projects: [],
      files: [projectFile('missing', 'README.md', 'readme')],
      activeProjectId: 'missing',
      activeFileIds: ['file-1'],
    } satisfies Partial<ProjectContextState>);

    expect(state.projects).toEqual([]);
    expect(state.files).toEqual([]);
    expect(state.activeProjectId).toBeNull();
    expect(state.activeFileIds).toEqual([]);
  });
});

function projectFile(projectId: string, path: string, content: string): ProjectFile {
  return {
    id: `file-${path}`,
    projectId,
    path,
    content,
    sizeBytes: new TextEncoder().encode(content).length,
    sourceKind: 'manual',
    createdAt: 1,
  };
}
