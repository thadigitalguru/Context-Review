const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseRequest } = require('../src/parser/parser');

function loadFixture(name) {
  const file = path.join(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('parses anthropic captures into normalized breakdown categories', () => {
  const capture = loadFixture('anthropic-capture.json');
  const breakdown = parseRequest(capture);

  assert.equal(breakdown.provider, 'anthropic');
  assert.equal(breakdown.agent.id, 'claude_code');
  assert.equal(breakdown.tool_definitions.count, 2);
  assert.equal(breakdown.tool_calls.count, 1);
  assert.equal(breakdown.tool_results.count, 1);
  assert.ok(breakdown.thinking_blocks.tokens > 0);
  assert.equal(breakdown.tool_results.content[0].source.msgIndex, 3);
  assert.equal(breakdown.token_counting.method, 'heuristic_chars');
});

test('parses openai captures and preserves tool call/result sources', () => {
  const capture = loadFixture('openai-capture.json');
  const breakdown = parseRequest(capture);

  assert.equal(breakdown.provider, 'openai');
  assert.equal(breakdown.agent.id, 'codex');
  assert.equal(breakdown.system_prompts.content.length, 1);
  assert.equal(breakdown.tool_definitions.count, 1);
  assert.equal(breakdown.tool_calls.count, 1);
  assert.equal(breakdown.tool_results.count, 1);
  assert.equal(breakdown.tool_calls.content[0].source.path, 'messages[2].tool_calls[0]');
  assert.equal(breakdown.response_tokens.cacheRead, 120);
});

test('parses google captures into the shared category model', () => {
  const capture = loadFixture('google-capture.json');
  const breakdown = parseRequest(capture);

  assert.equal(breakdown.provider, 'google');
  assert.equal(breakdown.agent.id, 'gemini_cli');
  assert.equal(breakdown.system_prompts.content.length, 1);
  assert.equal(breakdown.tool_definitions.count, 1);
  assert.equal(breakdown.tool_calls.count, 1);
  assert.equal(breakdown.tool_results.count, 1);
  assert.ok(breakdown.total_tokens > 0);
});
