const { countTokens, stringifyValue } = require('../tokens/counter');
const { normalizeCapture, ensureNormalizedCompatibility } = require('./normalize');

const TOOL_FINGERPRINTS = {
  claude_code: { patterns: ['Claude Code', 'claude-code', 'You are Claude, a helpful AI assistant made by Anthropic'], name: 'Claude Code' },
  aider: { patterns: ['aider', 'SEARCH/REPLACE'], name: 'Aider' },
  codex: { patterns: ['codex', 'Codex'], name: 'Codex' },
  cursor: { patterns: ['cursor', 'Cursor'], name: 'Cursor' },
  copilot: { patterns: ['copilot', 'GitHub Copilot'], name: 'GitHub Copilot' },
  gemini_cli: { patterns: ['gemini', 'Gemini CLI'], name: 'Gemini CLI' },
  pi: { patterns: ['pi-ai', 'Pi'], name: 'Pi' },
};

const CATEGORY_KEYS = [
  'system_prompts',
  'tool_definitions',
  'tool_calls',
  'tool_results',
  'assistant_text',
  'user_text',
  'thinking_blocks',
  'media',
];

function createEmptyBreakdown(provider, agent) {
  return {
    system_prompts: { tokens: 0, content: [], percentage: 0, token_method: 'heuristic_chars', token_confidence: 'low' },
    tool_definitions: { tokens: 0, content: [], count: 0, percentage: 0, token_method: 'heuristic_chars', token_confidence: 'low' },
    tool_calls: { tokens: 0, content: [], count: 0, percentage: 0, token_method: 'heuristic_chars', token_confidence: 'low' },
    tool_results: { tokens: 0, content: [], count: 0, percentage: 0, token_method: 'heuristic_chars', token_confidence: 'low' },
    assistant_text: { tokens: 0, content: [], percentage: 0, token_method: 'heuristic_chars', token_confidence: 'low' },
    user_text: { tokens: 0, content: [], messageCount: 0, percentage: 0, token_method: 'heuristic_chars', token_confidence: 'low' },
    thinking_blocks: { tokens: 0, content: [], percentage: 0, token_method: 'heuristic_chars', token_confidence: 'low' },
    media: { tokens: 0, content: [], count: 0, percentage: 0, token_method: 'heuristic_chars', token_confidence: 'low' },
    total_tokens: 0,
    model: '',
    provider,
    agent,
    token_counting: {
      method: 'heuristic_chars',
      confidence: 'low',
      source: 'local_estimate',
    },
  };
}

function parseRequest(capture) {
  const { provider, request, response } = capture;
  const body = request.body;
  if (!body) return null;

  const agent = detectAgent(body, request.headers || {});
  const normalized = normalizeCapture(capture);
  if (!normalized) return null;
  const compatibility = ensureNormalizedCompatibility(normalized);
  if (!compatibility.ok) return null;

  const breakdown = createEmptyBreakdown(provider, agent);
  const compatibleNormalized = compatibility.normalized;

  compatibleNormalized.systemPrompts.forEach((prompt) => {
    const stats = countTokens(prompt.text, { label: 'system_prompt', model: compatibleNormalized.model, provider });
    breakdown.system_prompts.tokens += stats.tokens;
    breakdown.system_prompts.content.push({
      type: 'text',
      text: prompt.text.substring(0, 500),
      fullLength: prompt.text.length,
      tokens: stats.tokens,
      token_method: stats.method,
      token_confidence: stats.confidence,
      source: prompt.source,
    });
  });

  compatibleNormalized.toolDefinitions.forEach((tool) => {
    const stats = countTokens(tool.raw, { label: 'tool_definition', model: compatibleNormalized.model, provider });
    breakdown.tool_definitions.tokens += stats.tokens;
    breakdown.tool_definitions.count++;
    breakdown.tool_definitions.content.push({
      name: tool.name,
      tokens: stats.tokens,
      token_method: stats.method,
      token_confidence: stats.confidence,
      source: tool.source,
    });
  });

  compatibleNormalized.items.forEach((item) => {
    const stats = countTokens(item.text, { label: item.category, model: compatibleNormalized.model, provider });
    const preview = stringifyValue(item.text).substring(0, item.category === 'tool_results' ? 300 : 200);
    const baseEntry = {
      role: item.role,
      preview,
      tokens: stats.tokens,
      token_method: stats.method,
      token_confidence: stats.confidence,
      msgIndex: item.source.msgIndex,
      partIndex: item.source.partIndex,
      source: item.source,
    };

    if (item.category === 'tool_calls') {
      breakdown.tool_calls.tokens += stats.tokens;
      breakdown.tool_calls.count++;
      breakdown.tool_calls.content.push({
        ...baseEntry,
        name: item.name || 'unknown',
        id: item.id,
      });
    } else if (item.category === 'tool_results') {
      breakdown.tool_results.tokens += stats.tokens;
      breakdown.tool_results.count++;
      breakdown.tool_results.content.push({
        ...baseEntry,
        name: item.name,
        tool_use_id: item.toolUseId,
        tool_call_id: item.toolCallId,
        fullLength: stringifyValue(item.text).length,
        hasHtml: detectHtml(item.text),
        hasRoleConfusion: detectRoleConfusion(item.text),
      });
    } else if (item.category === 'assistant_text') {
      breakdown.assistant_text.tokens += stats.tokens;
      breakdown.assistant_text.content.push(baseEntry);
    } else if (item.category === 'user_text') {
      breakdown.user_text.tokens += stats.tokens;
      breakdown.user_text.messageCount++;
      breakdown.user_text.content.push(baseEntry);
    } else if (item.category === 'thinking_blocks') {
      breakdown.thinking_blocks.tokens += stats.tokens;
      breakdown.thinking_blocks.content.push(baseEntry);
    } else if (item.category === 'media') {
      breakdown.media.tokens += stats.tokens;
      breakdown.media.count++;
      breakdown.media.content.push(baseEntry);
    }
  });

  breakdown.total_tokens = CATEGORY_KEYS.reduce((sum, key) => sum + breakdown[key].tokens, 0);

  if (breakdown.total_tokens > 0) {
    CATEGORY_KEYS.forEach((key) => {
      breakdown[key].percentage = Math.round((breakdown[key].tokens / breakdown.total_tokens) * 100);
    });
  }

  CATEGORY_KEYS.forEach((key) => {
    const summary = summarizeCategoryCounting(breakdown[key]);
    breakdown[key].token_method = summary.method;
    breakdown[key].token_confidence = summary.confidence;
  });

  breakdown.model = compatibleNormalized.model;
  breakdown.token_counting = summarizeTokenCounting(breakdown);
  breakdown.response_tokens = response && response.body
    ? extractResponseTokens(response, provider)
    : { input: 0, output: 0 };

  return breakdown;
}

function detectHtml(text) {
  if (!text || text.length < 10) return false;
  const htmlPatterns = [
    /<!--[\s\S]*?-->/,
    /<(div|span|table|tr|td|th|ul|ol|li|p|h[1-6]|section|article|header|footer|nav|main|form|input|button|script|style|link|meta|head|body|html)\b/i,
    /<\/[a-z]+>/i,
  ];
  return htmlPatterns.some((p) => p.test(text));
}

function detectRoleConfusion(text) {
  if (!text || text.length < 20) return false;
  const confusionPatterns = [
    /you are a (helpful|knowledgeable|friendly)/i,
    /as an ai (assistant|model|language)/i,
    /your (role|task|job|purpose) is to/i,
    /you should (always|never|remember)/i,
    /instructions?:\s*(you|your|the assistant)/i,
  ];
  return confusionPatterns.some((p) => p.test(text));
}

function detectAgent(body, headers) {
  const searchText = JSON.stringify(body).substring(0, 5000) + ' ' + JSON.stringify(headers);

  for (const [key, fingerprint] of Object.entries(TOOL_FINGERPRINTS)) {
    for (const pattern of fingerprint.patterns) {
      if (searchText.toLowerCase().includes(pattern.toLowerCase())) {
        return { id: key, name: fingerprint.name };
      }
    }
  }

  const userAgent = headers['user-agent'] || '';
  if (userAgent) {
    return { id: 'unknown', name: userAgent.split('/')[0] || 'Unknown Agent' };
  }

  return { id: 'unknown', name: 'Unknown Agent' };
}

function extractResponseTokens(response, provider) {
  const body = response.body;
  if (!body) return { input: 0, output: 0 };

  if (body.usage) {
    if (provider === 'anthropic') {
      return {
        input: body.usage.input_tokens || 0,
        output: body.usage.output_tokens || 0,
        cacheCreation: body.usage.cache_creation_input_tokens || 0,
        cacheRead: body.usage.cache_read_input_tokens || 0,
      };
    }
    if (provider === 'openai') {
      return {
        input: body.usage.prompt_tokens || 0,
        output: body.usage.completion_tokens || 0,
        cacheRead: body.usage.prompt_tokens_details?.cached_tokens || 0,
      };
    }
  }

  if (body.usageMetadata) {
    return {
      input: body.usageMetadata.promptTokenCount || 0,
      output: body.usageMetadata.candidatesTokenCount || 0,
      cacheRead: body.usageMetadata.cachedContentTokenCount || 0,
    };
  }

  return { input: 0, output: 0 };
}

function summarizeTokenCounting(breakdown) {
  const samples = [
    ...breakdown.system_prompts.content,
    ...breakdown.tool_definitions.content,
    ...breakdown.tool_calls.content,
    ...breakdown.tool_results.content,
    ...breakdown.assistant_text.content,
    ...breakdown.user_text.content,
    ...breakdown.thinking_blocks.content,
  ].filter(Boolean);

  const exactSample = samples.find((sample) => String(sample.token_method || '').startsWith('tiktoken_'));
  if (exactSample) {
    return {
      method: exactSample.token_method,
      confidence: 'high',
      source: 'tokenizer',
    };
  }

  return {
    method: 'heuristic_chars',
    confidence: 'low',
    source: 'local_estimate',
  };
}

function summarizeCategoryCounting(category) {
  const content = Array.isArray(category.content) ? category.content : [];
  const exactSample = content.find((entry) => String(entry.token_method || '').startsWith('tiktoken_'));
  if (exactSample) {
    return {
      method: exactSample.token_method,
      confidence: exactSample.token_confidence || 'high',
    };
  }

  const sample = content.find((entry) => entry.token_method);
  if (sample) {
    return {
      method: sample.token_method,
      confidence: sample.token_confidence || 'low',
    };
  }

  return {
    method: 'heuristic_chars',
    confidence: 'low',
  };
}

module.exports = { parseRequest, detectAgent, detectHtml, detectRoleConfusion };
