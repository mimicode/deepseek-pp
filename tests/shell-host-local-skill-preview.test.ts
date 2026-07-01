import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const hostPath = resolve(testDir, '../packages/shell-host/native/shell-mcp-host.mjs');
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('shell native host local_skill_preview', () => {
  it('does not collect nested Skill resources into the parent Skill', async () => {
    const root = createNestedSkillFixture();
    const response = await callNativeHost('local_skill_preview', { rootPath: root });

    expect(response.error).toBeUndefined();
    const data = response.result?.structuredContent?.data;
    expect(data?.skills).toHaveLength(2);

    const rootSkill = data.skills.find((skill: { path: string }) => skill.path === 'SKILL.md');
    const nestedSkill = data.skills.find((skill: { path: string }) => skill.path === 'nested/SKILL.md');

    expect(rootSkill?.includedFiles.map((file: { path: string }) => file.path)).toEqual(['references/root.md']);
    expect(rootSkill?.scriptFiles).toEqual([]);
    expect(nestedSkill?.includedFiles.map((file: { path: string }) => file.path)).toEqual(['nested/references/child.md']);
    expect(nestedSkill?.scriptFiles).toEqual([
      expect.objectContaining({ path: 'nested/scripts/run.py' }),
    ]);
  });
});

describe('shell native host local_folder_pick', () => {
  it('keeps Windows folder picker arguments out of the PowerShell command text', () => {
    const source = readFileSync(hostPath, 'utf8');

    expect(source).toContain("'-EncodedCommand', encodePowerShellCommand(script)");
    expect(source).toContain('DPP_FOLDER_PICK_TITLE');
    expect(source).toContain('DPP_FOLDER_PICK_DEFAULT_PATH');
    expect(source).not.toContain("'-Command', script, title");
  });
});

describe('shell native host local_file_* tools', () => {
  it('writes and reads large UTF-8 text without shell escaping', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deepseek-pp-local-file-'));
    tempRoots.push(root);
    const filePath = join(root, 'nested/report.txt');
    const content = `标题：生态治理\n${'段落-中文-特殊字符-{}[]<>&"\n'.repeat(4000)}`;

    const writeResponse = await callNativeHost('local_file_write', {
      path: filePath,
      content,
      create_directories: true,
    });
    expect(writeResponse.error).toBeUndefined();
    expect(writeResponse.result?.structuredContent?.data).toMatchObject({
      path: filePath,
      append: false,
    });

    const statResponse = await callNativeHost('local_file_stat', { path: filePath });
    expect(statResponse.error).toBeUndefined();
    expect(statResponse.result?.structuredContent?.data).toMatchObject({
      exists: true,
      isFile: true,
      path: filePath,
    });

    const firstRead = await callNativeHost('local_file_read', {
      path: filePath,
      start: 0,
      max_chars: 1200,
    });
    expect(firstRead.error).toBeUndefined();
    expect(firstRead.result?.structuredContent?.data.content).toBe(content.slice(0, 1200));
    expect(firstRead.result?.structuredContent?.data.truncated).toBe(true);
    expect(firstRead.result?.structuredContent?.data.nextStart).toBe(1200);

    const secondRead = await callNativeHost('local_file_read', {
      path: filePath,
      start: firstRead.result?.structuredContent?.data.nextStart,
      max_chars: 1200,
    });
    expect(secondRead.error).toBeUndefined();
    expect(secondRead.result?.structuredContent?.data.content).toBe(content.slice(1200, 2400));

    const persisted = readFileSync(filePath, 'utf8');
    expect(persisted).toBe(content);
  });
});

function createNestedSkillFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'deepseek-pp-local-skill-'));
  tempRoots.push(root);

  mkdirSync(join(root, 'references'), { recursive: true });
  mkdirSync(join(root, 'nested/references'), { recursive: true });
  mkdirSync(join(root, 'nested/scripts'), { recursive: true });

  writeFileSync(join(root, 'SKILL.md'), [
    '---',
    'name: parent-skill',
    'description: Parent Skill',
    '---',
    '',
    'Use references/root.md only.',
  ].join('\n'));
  writeFileSync(join(root, 'references/root.md'), 'Parent reference.');

  writeFileSync(join(root, 'nested/SKILL.md'), [
    '---',
    'name: child-skill',
    'description: Child Skill',
    '---',
    '',
    'Use references/child.md and scripts/run.py.',
  ].join('\n'));
  writeFileSync(join(root, 'nested/references/child.md'), 'Child reference.');
  writeFileSync(join(root, 'nested/scripts/run.py'), 'print("child")\n');

  return root;
}

async function callNativeHost(name: string, args: Record<string, unknown>) {
  const child = spawn(process.execPath, [hostPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0);
  let stderr = '';
  let settled = false;

  const response = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Native host timed out. stderr: ${stderr}`));
    }, 10_000);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      const message = tryReadNativeMessage(stdout);
      if (!message || settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      resolve(message);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Native host exited before responding (${code}). stderr: ${stderr}`));
    });

    child.stdin.end(createNativeFrame({
      protocol: 'deepseek-pp-mcp-native',
      version: 1,
      message: {
        jsonrpc: '2.0',
        id: 'test-call',
        method: 'tools/call',
        params: {
          name,
          arguments: args,
        },
      },
    }));
  });

  child.kill();
  return response;
}

function createNativeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function tryReadNativeMessage(buffer: Buffer): any | null {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32LE(0);
  if (buffer.length < 4 + length) return null;
  return JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
}
