import type { McpServerCreateInput } from '../mcp/types';
import { MULTIMODAL_MCP_NATIVE_HOST, MULTIMODAL_MCP_SERVER_NAME } from './contracts';

export interface MultimodalMcpPresetOptions {
  nativeHost?: string;
  enabled?: boolean;
  executionEnabled?: boolean;
}

export function createMultimodalMcpPresetInput(
  options: MultimodalMcpPresetOptions = {},
): McpServerCreateInput {
  return {
    displayName: MULTIMODAL_MCP_SERVER_NAME,
    enabled: options.enabled ?? false,
    transport: {
      kind: 'native_messaging',
      nativeHost: options.nativeHost ?? MULTIMODAL_MCP_NATIVE_HOST,
    },
    headers: [],
    secrets: [],
    timeouts: {
      connectMs: 5_000,
      requestMs: 180_000,
      discoveryMs: 10_000,
    },
    limits: {
      maxResultBytes: 128_000,
      maxToolCount: 8,
    },
    allowlist: {
      mode: 'allow',
      toolNames: ['vision_status'],
    },
    execution: {
      enabled: options.executionEnabled ?? false,
      mode: 'manual',
    },
  };
}
