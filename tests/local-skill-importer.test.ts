import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_MCP_NATIVE_HOST, SHELL_MCP_SERVER_NAME } from '../core/shell';

vi.mock('../core/mcp/store', () => ({
  getAllMcpServers: vi.fn(),
  updateMcpServer: vi.fn(),
}));

vi.mock('../core/mcp/discovery', () => ({
  executeMcpToolCall: vi.fn(),
  refreshMcpServerDiscovery: vi.fn(),
}));

import { executeMcpToolCall, refreshMcpServerDiscovery } from '../core/mcp/discovery';
import { getAllMcpServers, updateMcpServer } from '../core/mcp/store';
import type { McpServerConfig } from '../core/mcp/types';
import { importLocalSkillSource, pickLocalSkillFolder, previewLocalSkillSource } from '../core/skill/local-importer';

const SKILL_STORAGE_KEY = 'deepseek_pp_skills';

let storage: Record<string, unknown>;

beforeEach(() => {
  storage = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[] | null | undefined) => {
          if (typeof key === 'string') return { [key]: storage[key] };
          if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, storage[item]]));
          return { ...storage };
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          storage = { ...storage, ...values };
        }),
      },
    },
  });
  const shellServer = createShellServer(['local_skill_preview', 'local_folder_pick']);
  vi.mocked(getAllMcpServers).mockResolvedValue([shellServer]);
  vi.mocked(updateMcpServer).mockImplementation(async (_id, patch) => ({
    ...shellServer,
    ...patch,
    allowlist: patch.allowlist ?? shellServer.allowlist,
  }));
  vi.mocked(refreshMcpServerDiscovery).mockResolvedValue({} as never);
  vi.mocked(executeMcpToolCall).mockResolvedValue(createLocalSkillToolResult());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('local Skill importer', () => {
  it('picks local Skill folders through Shell MCP', async () => {
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce(createFolderPickToolResult());

    await expect(pickLocalSkillFolder('/Users/me/.codex/skills')).resolves.toBe('/Users/me/.codex/skills/demo');
    expect(executeMcpToolCall).toHaveBeenCalledWith(expect.objectContaining({
      name: 'local_folder_pick',
      descriptorId: 'mcp:shell-local:local_folder_pick',
      payload: {
        title: 'Choose a local Skill folder',
        defaultPath: '/Users/me/.codex/skills',
      },
    }));
  });

  it('adds local file tools to older Shell allowlists before picking folders', async () => {
    vi.mocked(getAllMcpServers).mockResolvedValueOnce([createShellServer(['shell_status', 'python_status'])]);
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce(createFolderPickToolResult());

    await expect(pickLocalSkillFolder()).resolves.toBe('/Users/me/.codex/skills/demo');
    expect(updateMcpServer).toHaveBeenCalledWith('shell-local', {
      allowlist: {
        mode: 'allow',
        toolNames: [
          'shell_status',
          'python_status',
          'local_skill_preview',
          'local_folder_pick',
          'local_file_stat',
          'local_file_read',
          'local_file_write',
        ],
      },
    });
  });

  it('refreshes Shell discovery once when the folder picker cache is stale', async () => {
    vi.mocked(executeMcpToolCall)
      .mockResolvedValueOnce({
        ok: false,
        summary: 'MCP tool unavailable',
        detail: 'MCP tool is not available on server Shell Local.',
        name: 'local_folder_pick',
        error: {
          code: 'mcp_tool_not_found',
          message: 'MCP tool is not available on server Shell Local.',
          retryable: true,
        },
      })
      .mockResolvedValueOnce(createFolderPickToolResult());

    await expect(pickLocalSkillFolder()).resolves.toBe('/Users/me/.codex/skills/demo');
    expect(refreshMcpServerDiscovery).toHaveBeenCalledWith('shell-local');
    expect(executeMcpToolCall).toHaveBeenCalledTimes(2);
  });

  it('explains legacy Windows folder picker failures as stale Shell Native Host installs', async () => {
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce({
      ok: false,
      summary: 'MCP tool failed',
      detail: 'Command failed: powershell.exe -NoProfile -STA -Command Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {}; Choose a local Skill folder Choose : CommandNotFoundException',
      name: 'local_folder_pick',
      error: {
        code: 'mcp_tool_failed',
        message: 'Command failed: powershell.exe -NoProfile -STA -Command Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; Choose a local Skill folder Choose : CommandNotFoundException',
        retryable: false,
      },
    });

    const pick = pickLocalSkillFolder();
    await expect(pick).rejects.toThrow('copy the generated install command');
    await expect(pick).rejects.not.toThrow('<your-extension-id>');
  });

  it('previews and imports local Skills while preserving script execution boundaries', async () => {
    const preview = await previewLocalSkillSource('/Users/me/.codex/skills/demo');

    expect(preview.source.provider).toBe('local');
    expect(preview.skills[0]).toMatchObject({
      path: 'SKILL.md',
      importName: 'demo-local',
      description: 'Demo local Skill',
    });
    expect(preview.skills[0].scriptFiles).toEqual([{ path: 'scripts/run.py', bytes: 18 }]);

    const result = await importLocalSkillSource({
      rootPath: '/Users/me/.codex/skills/demo',
      selectedPaths: ['SKILL.md'],
    });

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].remote).toMatchObject({
      provider: 'local',
      localRootPath: '/Users/me/.codex/skills/demo',
      localDirectory: '/Users/me/.codex/skills/demo',
      scriptFiles: [{ path: 'scripts/run.py', bytes: 18 }],
    });
    expect(result.imported[0].instructions).toContain('Local Execution Boundary');
    expect(result.imported[0].instructions).toContain('Run commands with cwd set to the Skill directory path: /Users/me/.codex/skills/demo');
    expect(result.imported[0].instructions).toContain('scripts/run.py');
    expect(result.imported[0].instructions).toContain('### references/guide.md');
    expect(storage[SKILL_STORAGE_KEY]).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'demo-local', source: 'remote' }),
    ]));
  });

  it('renders nested local Skill resources relative to the Skill directory', async () => {
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce(createNestedLocalSkillToolResult());

    const result = await importLocalSkillSource({
      rootPath: '/Users/me/.codex/skills',
      selectedPaths: ['nested/SKILL.md'],
    });

    const imported = result.imported[0];
    expect(imported.remote).toMatchObject({
      provider: 'local',
      localRootPath: '/Users/me/.codex/skills',
      localDirectory: '/Users/me/.codex/skills/nested',
      scriptFiles: [{ path: 'nested/scripts/run.py', bytes: 15 }],
    });
    expect(imported.instructions).toContain('Run commands with cwd set to the Skill directory path: /Users/me/.codex/skills/nested');
    expect(imported.instructions).toContain('- scripts/run.py (15 bytes)');
    expect(imported.instructions).toContain('### references/child.md');
    expect(imported.instructions).not.toContain('- nested/scripts/run.py');
    expect(imported.instructions).not.toContain('### nested/references/child.md');
  });

  it('imports a BOM-prefixed SKILL.md without losing the frontmatter name (issue #296)', async () => {
    // Editors on Windows commonly save SKILL.md with a UTF-8 BOM. Previously
    // the BOM defeated the `^---` frontmatter fence, `name:` was dropped, and
    // the importer threw "Local Skill is missing a valid name."
    const content = [
      '---',
      'name: ref-material-writing',
      'description: BOM-safe import',
      '---',
      '',
      '# 参考材料写作',
      '',
      'body',
    ].join('\n');
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce({
      ok: true,
      summary: 'MCP tool executed',
      output: {
        ok: true,
        data: {
          rootPath: 'D:\\skills\\ref-material-writing',
          displayName: 'ref-material-writing',
          directoryName: 'ref-material-writing',
          warnings: [],
          truncated: false,
          skills: [
            {
              path: 'SKILL.md',
              directory: '',
              directoryPath: 'D:\\skills\\ref-material-writing',
              content: `\uFEFF${content}`,
              bodyBytes: content.length + 1,
              includedFiles: [],
              omittedFiles: [],
              scriptFiles: [],
              warnings: [],
            },
          ],
        },
      },
    });

    const result = await importLocalSkillSource({
      rootPath: 'D:\\skills\\ref-material-writing',
      selectedPaths: ['SKILL.md'],
    });

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].name).toBe('ref-material-writing');
  });

  it('falls back to a hash slug when only a non-ASCII name is available (issue #296)', async () => {
    // No `name:` field, Chinese H1 title, Chinese directory — every source
    // slug is non-ASCII. The importer must not throw; it derives a stable
    // `skill-<hash>` slug so the user can rename it later.
    const content = ['---', 'description: 中文 only', '---', '', '# 参考材料写作', '', 'body'].join('\n');
    vi.mocked(executeMcpToolCall).mockResolvedValueOnce({
      ok: true,
      summary: 'MCP tool executed',
      output: {
        ok: true,
        data: {
          rootPath: 'D:\\写作助手',
          displayName: '写作助手',
          directoryName: '写作助手',
          warnings: [],
          truncated: false,
          skills: [
            {
              path: 'SKILL.md',
              directory: '',
              directoryPath: 'D:\\写作助手',
              content,
              bodyBytes: content.length,
              includedFiles: [],
              omittedFiles: [],
              scriptFiles: [],
              warnings: [],
            },
          ],
        },
      },
    });

    const result = await importLocalSkillSource({
      rootPath: 'D:\\写作助手',
      selectedPaths: ['SKILL.md'],
    });

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].name).toMatch(/^skill-[a-z0-9]{2,8}$/);
  });
});

function createShellServer(toolNames: string[]): McpServerConfig {
  return {
    id: 'shell-local',
    displayName: SHELL_MCP_SERVER_NAME,
    enabled: true,
    transport: { kind: 'native_messaging' as const, nativeHost: SHELL_MCP_NATIVE_HOST },
    execution: { enabled: true, mode: 'manual' as const },
    allowlist: { mode: 'allow' as const, toolNames },
    timeouts: { connectMs: 1, requestMs: 1, discoveryMs: 1 },
    limits: { maxResultBytes: 128_000, maxToolCount: 8 },
    headers: [],
    secrets: [],
    version: 1 as const,
    status: 'ready' as const,
    lastConnectedAt: 1,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createFolderPickToolResult() {
  return {
    ok: true,
    summary: 'MCP tool executed',
    output: {
      ok: true,
      data: {
        path: '/Users/me/.codex/skills/demo',
      },
    },
  };
}

function createLocalSkillToolResult() {
  const content = [
    '---',
    'name: demo-local',
    'description: Demo local Skill',
    'version: 1.2.3',
    '---',
    '',
    '# Demo',
    '',
    'Use scripts/run.py when computation is needed.',
  ].join('\n');

  return {
    ok: true,
    summary: 'MCP tool executed',
    output: {
      ok: true,
      data: {
        rootPath: '/Users/me/.codex/skills/demo',
        displayName: 'demo',
        directoryName: 'demo',
        warnings: [],
        truncated: false,
        skills: [
          {
            path: 'SKILL.md',
            directory: '',
            directoryPath: '/Users/me/.codex/skills/demo',
            content,
            bodyBytes: content.length,
            includedFiles: [
              {
                path: 'references/guide.md',
                bytes: 11,
                content: 'Guide text.',
              },
            ],
            omittedFiles: [],
            scriptFiles: [{ path: 'scripts/run.py', bytes: 18 }],
            warnings: [],
          },
        ],
      },
    },
  };
}

function createNestedLocalSkillToolResult() {
  const content = [
    '---',
    'name: nested-local',
    'description: Nested local Skill',
    '---',
    '',
    '# Nested',
    '',
    'Use references/child.md and scripts/run.py.',
  ].join('\n');

  return {
    ok: true,
    summary: 'MCP tool executed',
    output: {
      ok: true,
      data: {
        rootPath: '/Users/me/.codex/skills',
        displayName: 'skills',
        directoryName: 'skills',
        warnings: [],
        truncated: false,
        skills: [
          {
            path: 'nested/SKILL.md',
            directory: 'nested',
            directoryPath: '/Users/me/.codex/skills/nested',
            content,
            bodyBytes: content.length,
            includedFiles: [
              {
                path: 'nested/references/child.md',
                bytes: 11,
                content: 'Child guide.',
              },
            ],
            omittedFiles: [],
            scriptFiles: [{ path: 'nested/scripts/run.py', bytes: 15 }],
            warnings: [],
          },
        ],
      },
    },
  };
}
