import { describe, expect, it } from 'vitest';
import { createMultimodalMcpPresetInput } from '../core/multimodal/policy';
import { MULTIMODAL_MCP_NATIVE_HOST, MULTIMODAL_MCP_SERVER_NAME } from '../core/multimodal/contracts';

describe('createMultimodalMcpPresetInput', () => {
  it('defaults Multimodal MCP to explicit manual opt-in', () => {
    const preset = createMultimodalMcpPresetInput();

    expect(preset.displayName).toBe(MULTIMODAL_MCP_SERVER_NAME);
    expect(preset.enabled).toBe(false);
    expect(preset.transport).toEqual({
      kind: 'native_messaging',
      nativeHost: MULTIMODAL_MCP_NATIVE_HOST,
    });
    expect(preset.allowlist).toEqual({ mode: 'allow', toolNames: ['vision_status'] });
    expect(preset.execution).toEqual({ enabled: false, mode: 'manual' });
  });
});
