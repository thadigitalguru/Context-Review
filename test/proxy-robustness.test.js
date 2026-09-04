const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectProvider,
  parseStreamedResponse,
  reconstructOpenAIStream,
  isStreamingRequest,
  resolveProxyLimits,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_STREAM_CHARS,
} = require('../src/proxy/proxy');
const { parseRequest } = require('../src/parser/parser');

test('detectProvider routes OpenAI Responses API to openai', () => {
  assert.equal(detectProvider('/v1/responses').name, 'openai');
  assert.equal(detectProvider('/v1/chat/completions').name, 'openai');
  assert.equal(detectProvider('/v1/messages').name, 'anthropic');
  assert.equal(detectProvider('/v1beta/models/gemini-2.5:generateContent').name, 'google');
  assert.equal(detectProvider('/v1/unknown'), null);
});

test('isStreamingRequest detects Responses API stream flag', () => {
  assert.equal(isStreamingRequest({}, { stream: true }, '/v1/responses'), true);
  assert.equal(isStreamingRequest({}, {}, '/v1/responses'), false);
});

test('reconstructOpenAIStream assembles Responses API output_text deltas', () => {
  const events = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.output_text.delta', delta: ' world' },
    { response: { output_text: '!' } },
  ];
  const out = reconstructOpenAIStream(events);
  assert.equal(out.choices[0].message.content, 'Hello world!');
});

test('reconstructOpenAIStream assembles Responses API output item parts', () => {
  const events = [
    { response: { output: [{ content: [{ text: 'Hi' }, { output_text: ' there' }] }] } },
  ];
  const out = reconstructOpenAIStream(events);
  assert.equal(out.choices[0].message.content, 'Hi there');
});

test('parseStreamedResponse returns Google non-SSE JSON payloads directly', () => {
  const payload = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }], usageMetadata: { promptTokenCount: 3 } });
  const out = parseStreamedResponse([payload], 'google');
  assert.ok(out.candidates);
  assert.equal(out.candidates[0].content.parts[0].text, 'hi');
});

test('parseRequest attributes Responses API instructions/input/tools', () => {
  const capture = {
    provider: 'openai',
    timestamp: Date.now(),
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: {},
      body: {
        model: 'gpt-4o',
        instructions: 'You are helpful.',
        input: [
          { role: 'user', content: 'Fix the bug' },
          { type: 'function_call', name: 'edit_file', call_id: 'call-1', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call-1', output: 'done' },
        ],
        tools: [{ type: 'function', name: 'edit_file', parameters: {} }],
      },
    },
    response: { statusCode: 200, headers: {}, body: { usage: { input_tokens: 50, output_tokens: 10 } } },
    isStreaming: false,
  };
  const breakdown = parseRequest(capture);
  assert.ok(breakdown);
  assert.ok(breakdown.system_prompts.tokens > 0);
  assert.ok(breakdown.user_text.tokens > 0);
  assert.ok(breakdown.tool_calls.tokens > 0);
  assert.ok(breakdown.tool_results.tokens > 0);
  assert.equal(breakdown.tool_definitions.content[0].name, 'edit_file');
  assert.equal(breakdown.response_tokens.input, 50);
  assert.equal(breakdown.response_tokens.output, 10);
});

test('resolveProxyLimits honors env overrides and falls back to defaults', () => {
  assert.deepEqual(resolveProxyLimits({}), { maxBodyBytes: DEFAULT_MAX_BODY_BYTES, maxStreamChars: DEFAULT_MAX_STREAM_CHARS });
  assert.deepEqual(
    resolveProxyLimits({ CONTEXT_REVIEW_PROXY_MAX_BODY_BYTES: '1024', CONTEXT_REVIEW_PROXY_MAX_STREAM_CHARS: '2048' }),
    { maxBodyBytes: 1024, maxStreamChars: 2048 },
  );
  assert.deepEqual(
    resolveProxyLimits({ CONTEXT_REVIEW_PROXY_MAX_BODY_BYTES: 'nope' }),
    { maxBodyBytes: DEFAULT_MAX_BODY_BYTES, maxStreamChars: DEFAULT_MAX_STREAM_CHARS },
  );
});
