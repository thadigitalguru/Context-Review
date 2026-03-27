const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseRequest } = require('../src/parser/parser');
const { generateFindings } = require('../src/findings/findings');

function loadFixture(name) {
  const file = path.join(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('findings include exact source references and savings estimates', () => {
  const capture = loadFixture('anthropic-capture.json');
  const breakdown = parseRequest(capture);
  const session = {
    id: 'session-1',
    provider: 'anthropic',
    requestCount: 1,
    totalInputTokens: breakdown.total_tokens,
    totalOutputTokens: breakdown.response_tokens.output,
    agents: { [breakdown.agent.id]: { name: breakdown.agent.name } },
    turnBreakdowns: [{
      captureId: 'capture-1',
      timestamp: capture.timestamp,
      breakdown: {
        total: breakdown.total_tokens,
      },
      diff: {
        total: { delta: breakdown.total_tokens },
      },
    }],
  };

  const findings = generateFindings(session, [{ id: 'capture-1', breakdown }]);
  const htmlFinding = findings.find((finding) => finding.category === 'tool_results' && finding.source);
  const unusedToolFinding = findings.find((finding) => finding.category === 'tool_definitions' && Array.isArray(finding.tools));

  assert.ok(htmlFinding);
  assert.equal(htmlFinding.source.msgIndex, 3);
  assert.ok(htmlFinding.estimatedSavings.tokens >= 0);
  assert.equal(htmlFinding.recommendation.action.type, 'trim_tool_results');
  assert.ok(htmlFinding.recommendation.impact.tokens >= 0);

  assert.ok(unusedToolFinding);
  assert.equal(unusedToolFinding.tools[0].name, 'Write');
  assert.ok(unusedToolFinding.estimatedSavings.tokens > 0);
  assert.equal(unusedToolFinding.recommendation.action.type, 'remove_tools');
  assert.ok(unusedToolFinding.recommendation.impact.dollars >= 0);
});

test('media findings do not include simulation recommendations', () => {
  const breakdown = {
    model: 'gpt-4o',
    total_tokens: 1200,
    tool_results: { content: [], count: 0, percentage: 0, tokens: 0 },
    tool_definitions: { content: [], count: 0, percentage: 0, tokens: 0 },
    tool_calls: { content: [], count: 0, percentage: 0, tokens: 0 },
    thinking_blocks: { content: [], percentage: 0, tokens: 0 },
    system_prompts: { content: [], percentage: 0, tokens: 0 },
    assistant_text: { content: [], percentage: 0, tokens: 0 },
    user_text: { content: [], messageCount: 1, percentage: 0, tokens: 0 },
    media: { content: [{ source: { role: 'user', msgIndex: 1 }, tokens: 600 }], count: 1, percentage: 50, tokens: 600 },
  };

  const session = {
    id: 'session-media',
    provider: 'openai',
    requestCount: 1,
    totalInputTokens: 1200,
    totalOutputTokens: 0,
    agents: {},
    turnBreakdowns: [],
  };

  const findings = generateFindings(session, [{ id: 'capture-media', breakdown }]);
  const mediaFinding = findings.find((finding) => finding.category === 'media');
  assert.ok(mediaFinding);
  assert.equal(mediaFinding.recommendation, undefined);
});
