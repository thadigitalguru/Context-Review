const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseStreamedResponse,
  reconstructAnthropicStream,
  reconstructOpenAIStream,
  isStreamingRequest,
} = require('../src/proxy/proxy');

test('openai stream reconstruction assembles tool call argument deltas', () => {
  const events = [
    {
      model: 'gpt-4o',
      choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'edit_file', arguments: '{\"path\":\"app' } }] } }],
    },
    {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.js\",\"content\":\"ok\"}' } }] } }],
    },
    {
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    },
  ];

  const out = reconstructOpenAIStream(events);
  assert.equal(out.model, 'gpt-4o');
  assert.equal(out.choices[0].message.tool_calls.length, 1);
  assert.equal(out.choices[0].message.tool_calls[0].function.name, 'edit_file');
  assert.equal(out.choices[0].message.tool_calls[0].function.arguments, '{"path":"app.js","content":"ok"}');
  assert.equal(out.usage.prompt_tokens, 100);
});

test('anthropic stream reconstruction assembles tool_use partial_json deltas', () => {
  const events = [
    { type: 'message_start', message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 10 } } },
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'edit_file', input: '' } },
    { type: 'content_block_delta', delta: { partial_json: '{"path":"app.js","content":"hello"}' } },
    { type: 'content_block_stop' },
    { type: 'message_delta', usage: { output_tokens: 5 } },
  ];

  const out = reconstructAnthropicStream(events);
  assert.equal(out.content.length, 1);
  assert.deepEqual(out.content[0].input, { path: 'app.js', content: 'hello' });
  assert.equal(out.usage.output_tokens, 5);
});

test('parseStreamedResponse tolerates malformed and partial SSE payload lines', () => {
  const chunks = [
    'data: {"model":"gpt-4o","choices":[{"delta":{"content":"Hello"}}]}\n',
    'data: {"model":"gpt-4o","choices":[{"delta":{"content":" world"}}]}\n',
    'data: {"not_json"\n',
    'data: [DONE]\n',
  ];
  const out = parseStreamedResponse(chunks, 'openai');
  assert.equal(out.choices[0].message.content, 'Hello world');
});

test('isStreamingRequest detects explicit stream and google stream paths', () => {
  assert.equal(isStreamingRequest({}, { stream: true }, '/v1/chat/completions'), true);
  assert.equal(isStreamingRequest({}, {}, '/v1beta/models/gemini-2.5:streamGenerateContent'), true);
  assert.equal(isStreamingRequest({}, {}, '/v1/chat/completions'), false);
});

