import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpNativeMessagingTransport } from '../core/mcp/transports/native';
import type { McpServerConfig } from '../core/mcp/types';
import { MULTIMODAL_MCP_NATIVE_HOST } from '../core/multimodal/contracts';
import { saveMultimodalSettings } from '../core/multimodal/settings';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('multimodal native messaging env', () => {
  it('uses Settings as the only provider env source', async () => {
    const storage = new Map<string, unknown>();
    let postedEnvelope: any;

    vi.stubGlobal('chrome', {
      runtime: {
        connectNative: vi.fn(() => ({
          postMessage: vi.fn((value: unknown) => {
            postedEnvelope = value;
          }),
          onMessage: { addListener: vi.fn() },
          onDisconnect: { addListener: vi.fn() },
        })),
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            for (const [key, item] of Object.entries(value)) storage.set(key, item);
          }),
          remove: vi.fn(async (key: string) => {
            storage.delete(key);
          }),
        },
      },
    });

    await saveMultimodalSettings({
      openaiApiKey: 'settings-openai',
      geminiApiKey: 'settings-gemini',
      openaiImageModel: 'gpt-4.1-mini',
      geminiVideoModel: 'gemini-2.5-flash',
      openaiBaseUrl: 'https://openai-settings.example/v1',
      geminiBaseUrl: 'https://gemini-settings.example/v1beta',
    });

    const server = createServer({
      OPENAI_API_KEY: 'stale-openai',
      GEMINI_API_KEY: 'stale-gemini',
      OPENAI_BASE_URL: 'https://stale-openai.example/v1',
      GEMINI_BASE_URL: 'https://stale-gemini.example',
      EXTRA_STALE_VALUE: 'hidden',
    });

    await createMcpNativeMessagingTransport(server).notify!({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(postedEnvelope.server.env).toEqual({
      OPENAI_IMAGE_MODEL: 'gpt-4.1-mini',
      GEMINI_VIDEO_MODEL: 'gemini-2.5-flash',
      OPENAI_BASE_URL: 'https://openai-settings.example/v1',
      GEMINI_BASE_URL: 'https://gemini-settings.example/v1beta',
      OPENAI_API_KEY: 'settings-openai',
      GEMINI_API_KEY: 'settings-gemini',
    });
  });
});

function createServer(env: Record<string, string>): McpServerConfig {
  return {
    version: 1,
    id: 'multimodal',
    displayName: 'Multimodal Vision',
    enabled: true,
    transport: {
      kind: 'native_messaging',
      nativeHost: MULTIMODAL_MCP_NATIVE_HOST,
      env,
    },
    headers: [],
    secrets: [],
    timeouts: {
      connectMs: 1_000,
      requestMs: 1_000,
      discoveryMs: 1_000,
    },
    limits: {
      maxResultBytes: 1_000_000,
      maxToolCount: 64,
    },
    allowlist: {
      mode: 'all',
      toolNames: [],
    },
    execution: {
      enabled: true,
      mode: 'manual',
    },
    status: 'unknown',
    lastConnectedAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}
