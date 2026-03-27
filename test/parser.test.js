const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseRequest } = require('../src/parser/parser');

function loadFixture(name) {
  const file = path.join(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadExpected(name) {
  return loadFixture(name);
}

function summarizeBreakdown(breakdown) {
  return {
    provider: breakdown.provider,
    model: breakdown.model,
    total_tokens: breakdown.total_tokens,
    token_counting: breakdown.token_counting,
    response_tokens: breakdown.response_tokens,
    categories: {
      system_prompts: summarizeCategory(breakdown.system_prompts, breakdown.system_prompts.content.length),
      tool_definitions: summarizeCategory(breakdown.tool_definitions, breakdown.tool_definitions.count),
      tool_calls: summarizeCategory(breakdown.tool_calls, breakdown.tool_calls.count),
      tool_results: summarizeCategory(breakdown.tool_results, breakdown.tool_results.count),
      assistant_text: summarizeCategory(breakdown.assistant_text, breakdown.assistant_text.content.length),
      user_text: summarizeCategory(breakdown.user_text, breakdown.user_text.messageCount),
      thinking_blocks: summarizeCategory(breakdown.thinking_blocks, breakdown.thinking_blocks.content.length),
      media: summarizeCategory(breakdown.media, breakdown.media.count),
    },
    source_checks: {
      first_tool_call_source: breakdown.tool_calls.content[0]?.source || null,
      first_tool_result_source: breakdown.tool_results.content[0]?.source || null,
    },
  };
}

function summarizeCategory(category, count) {
  return {
    tokens: category.tokens,
    count,
    token_method: category.token_method,
    token_confidence: category.token_confidence,
  };
}

const CASES = [
  { name: 'anthropic', capture: 'anthropic-capture.json', expected: 'anthropic-expected.json', expectedAgent: 'claude_code' },
  { name: 'openai', capture: 'openai-capture.json', expected: 'openai-expected.json', expectedAgent: 'codex' },
  { name: 'google', capture: 'google-capture.json', expected: 'google-expected.json', expectedAgent: 'gemini_cli' },
];

for (const testCase of CASES) {
  test(`parser fixture matches golden output for ${testCase.name}`, () => {
    const capture = loadFixture(testCase.capture);
    const expected = loadExpected(testCase.expected);
    const breakdown = parseRequest(capture);
    const actual = summarizeBreakdown(breakdown);

    assert.equal(breakdown.agent.id, testCase.expectedAgent);
    assert.deepEqual(actual, expected);
  });
}
