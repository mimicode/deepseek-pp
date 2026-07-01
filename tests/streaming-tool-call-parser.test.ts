import { describe, expect, it } from 'vitest';
import { createStreamingToolCallParser } from '../core/interceptor/streaming-tool-call-parser';
import { createArtifactToolDescriptors } from '../core/artifact';
import { isExternalizedToolPayload } from '../core/tool/externalized-payload';

describe('createStreamingToolCallParser', () => {
  const descriptors = createArtifactToolDescriptors('en');

  it('emits a start event before a large artifact body completes', () => {
    const parser = createStreamingToolCallParser(descriptors);

    const start = parser.append('Intro <artifact_create>');
    expect(start.started).toHaveLength(1);
    expect(start.started[0]).toMatchObject({
      name: 'artifact_create',
      payload: {},
      raw: '<artifact_create>',
    });
    expect(start.completed).toHaveLength(0);

    const body = parser.append('{"filename":"demo.html","content":"');
    expect(body.started).toHaveLength(0);
    expect(body.completed).toHaveLength(0);
  });

  it('parses a completed artifact without carrying the huge raw block', () => {
    const parser = createStreamingToolCallParser(descriptors);
    const largeHtml = '<!doctype html>' + 'x'.repeat(20_000);

    parser.append('<artifact_create>');
    parser.append(JSON.stringify({
      filename: 'demo.html',
      content: largeHtml,
    }).slice(0, 12_000));
    const result = parser.append(`${JSON.stringify({
      filename: 'demo.html',
      content: largeHtml,
    }).slice(12_000)}</artifact_create>`);

    expect(result.completed).toHaveLength(1);
    expect(result.completed[0].payload).toMatchObject({
      filename: 'demo.html',
      content: largeHtml,
    });
    expect(result.completed[0].raw.length).toBeLessThan(2200);
    expect(result.completed[0].raw).toContain('payload');
  });

  it('handles literal less-than text before a tool tag', () => {
    const parser = createStreamingToolCallParser(descriptors);

    const result = parser.append('A < draft <artifact_create>{"filename":"a.txt","content":"ok"}</artifact_create>');

    expect(result.started).toHaveLength(1);
    expect(result.completed).toHaveLength(1);
    expect(result.completed[0].payload).toMatchObject({ filename: 'a.txt', content: 'ok' });
  });

  it('accepts whitespace-padded tool tags across chunks', () => {
    const parser = createStreamingToolCallParser(descriptors);
    const html = '<!doctype html><canvas id="stage"></canvas>' + '<script>draw()</script>'.repeat(2000);
    const payload = JSON.stringify({
      filename: 'canvas-demo.html',
      content: html,
      language: 'html',
    });

    const start = parser.append('Intro < artifact');
    expect(start.started).toHaveLength(0);

    const open = parser.append('_create >');
    expect(open.started).toHaveLength(1);
    expect(open.started[0]).toMatchObject({
      name: 'artifact_create',
      payload: {},
      raw: '< artifact_create >',
    });

    parser.append(payload.slice(0, 20_000));
    parser.append(payload.slice(20_000));
    expect(parser.append('</ artifact')).toMatchObject({ started: [], completed: [] });

    const completed = parser.append('_create > done');
    expect(completed.completed).toHaveLength(1);
    expect(completed.completed[0].payload).toMatchObject({
      filename: 'canvas-demo.html',
      content: html,
      language: 'html',
    });
    expect(completed.completed[0].raw.length).toBeLessThan(2200);
  });

  it('externalizes very large artifact payloads instead of retaining them in the page parser', () => {
    const parser = createStreamingToolCallParser(descriptors);
    const html = '<!doctype html>' + '<section>chunk</section>'.repeat(6000);
    const payload = JSON.stringify({
      filename: 'huge.html',
      content: html,
      language: 'html',
    });

    parser.append('<artifact_create>');
    const mid = parser.append(payload.slice(0, 40000));
    const end = parser.append(`${payload.slice(40000)}</artifact_create>`);

    expect(mid.streamed.length).toBe(0);
    expect(end.streamed.length).toBeGreaterThan(0);
    expect(end.completed).toHaveLength(1);
    expect(isExternalizedToolPayload(end.completed[0].payload)).toBe(true);
    expect(end.completed[0].raw).toContain('externalized');
  });
});
