import { describe, expect, it } from 'vitest';
import { validateBridgeMessage } from '../core/messaging/schema';

describe('bridge message schema', () => {
  it('accepts tool streaming bridge events used by the main-world hook', () => {
    expect(validateBridgeMessage({
      source: 'deepseek-pp-main',
      type: 'TOOL_CALL_STARTED',
      data: {},
    }, 'deepseek-pp-main')).not.toBeNull();

    expect(validateBridgeMessage({
      source: 'deepseek-pp-main',
      type: 'TOOL_CALL_CHUNK',
      data: { id: 'call-1', invocationName: 'artifact_create', chunk: 'abc' },
    }, 'deepseek-pp-main')).not.toBeNull();
  });
});
