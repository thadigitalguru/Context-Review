const TOOL_FINGERPRINTS = {
  'claude_code': { patterns: ['Claude Code', 'claude-code', 'You are Claude, a helpful AI assistant made by Anthropic'], name: 'Claude Code' },
  'aider': { patterns: ['aider', 'SEARCH/REPLACE'], name: 'Aider' },
  'codex': { patterns: ['codex', 'Codex'], name: 'Codex' },
  'cursor': { patterns: ['cursor', 'Cursor'], name: 'Cursor' },
  'copilot': { patterns: ['copilot', 'GitHub Copilot'], name: 'GitHub Copilot' },
  'gemini_cli': { patterns: ['gemini', 'Gemini CLI'], name: 'Gemini CLI' },
  'pi': { patterns: ['pi-ai', 'Pi'], name: 'Pi' },
};

function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text !== 'string') text = JSON.stringify(text);
  return Math.ceil(text.length / 3.5);
}

function parseRequest(capture) {
  const { provider, request, response } = capture;
  const body = request.body;
  if (!body) return null;

  const breakdown = {
    system_prompts: { tokens: 0, content: [], percentage: 0 },
    tool_definitions: { tokens: 0, content: [], count: 0, percentage: 0 },
    tool_calls: { tokens: 0, content: [], count: 0, percentage: 0 },
    tool_results: { tokens: 0, content: [], count: 0, percentage: 0 },
    assistant_text: { tokens: 0, content: [], percentage: 0 },
    user_text: { tokens: 0, content: [], messageCount: 0, percentage: 0 },
    thinking_blocks: { tokens: 0, content: [], percentage: 0 },
    media: { tokens: 0, count: 0, percentage: 0 },
    total_tokens: 0,
    model: '',
    provider: provider,
    agent: detectAgent(body, request.headers),
  };

  if (provider === 'anthropic') {
    parseAnthropicRequest(body, breakdown);
  } else if (provider === 'openai') {
    parseOpenAIRequest(body, breakdown);
  } else if (provider === 'google') {
    parseGoogleRequest(body, breakdown);
  }

  breakdown.total_tokens = breakdown.system_prompts.tokens +
    breakdown.tool_definitions.tokens +
    breakdown.tool_calls.tokens +
    breakdown.tool_results.tokens +
    breakdown.assistant_text.tokens +
    breakdown.user_text.tokens +
    breakdown.thinking_blocks.tokens +
    breakdown.media.tokens;

  if (breakdown.total_tokens > 0) {
    const pct = (cat) => Math.round((cat.tokens / breakdown.total_tokens) * 100);
    breakdown.system_prompts.percentage = pct(breakdown.system_prompts);
    breakdown.tool_definitions.percentage = pct(breakdown.tool_definitions);
    breakdown.tool_calls.percentage = pct(breakdown.tool_calls);
    breakdown.tool_results.percentage = pct(breakdown.tool_results);
    breakdown.assistant_text.percentage = pct(breakdown.assistant_text);
    breakdown.user_text.percentage = pct(breakdown.user_text);
    breakdown.thinking_blocks.percentage = pct(breakdown.thinking_blocks);
    breakdown.media.percentage = pct(breakdown.media);
  }

  if (response && response.body) {
    breakdown.response_tokens = extractResponseTokens(response, provider);
    breakdown.model = extractModel(body, response, provider);
  } else {
    breakdown.model = extractModel(body, null, provider);
  }

  return breakdown;
}

function parseAnthropicRequest(body, breakdown) {
  if (body.system) {
    if (typeof body.system === 'string') {
      breakdown.system_prompts.tokens = estimateTokens(body.system);
      breakdown.system_prompts.content.push({ type: 'text', text: body.system.substring(0, 500), fullLength: body.system.length });
    } else if (Array.isArray(body.system)) {
      for (const block of body.system) {
        if (block.type === 'text') {
          const tokens = estimateTokens(block.text);
          breakdown.system_prompts.tokens += tokens;
          breakdown.system_prompts.content.push({ type: 'text', text: block.text.substring(0, 500), fullLength: block.text.length });
        }
      }
    }
  }

  if (body.tools && Array.isArray(body.tools)) {
    breakdown.tool_definitions.count = body.tools.length;
    const toolsStr = JSON.stringify(body.tools);
    breakdown.tool_definitions.tokens = estimateTokens(toolsStr);
    breakdown.tool_definitions.content = body.tools.map(t => ({
      name: t.name,
      tokens: estimateTokens(JSON.stringify(t)),
    }));
  }

  if (body.messages && Array.isArray(body.messages)) {
    let msgIndex = 0;
    for (const msg of body.messages) {
      msgIndex++;
      if (msg.role === 'user' || msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          const tokens = estimateTokens(msg.content);
          if (msg.role === 'user') {
            breakdown.user_text.tokens += tokens;
            breakdown.user_text.messageCount++;
            breakdown.user_text.content.push({ role: msg.role, preview: msg.content.substring(0, 200), tokens, msgIndex });
          } else {
            breakdown.assistant_text.tokens += tokens;
            breakdown.assistant_text.content.push({ role: msg.role, preview: msg.content.substring(0, 200), tokens, msgIndex });
          }
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text') {
              const tokens = estimateTokens(block.text);
              if (msg.role === 'user') {
                breakdown.user_text.tokens += tokens;
                breakdown.user_text.content.push({ role: msg.role, preview: block.text.substring(0, 200), tokens, msgIndex });
              } else {
                breakdown.assistant_text.tokens += tokens;
                breakdown.assistant_text.content.push({ role: msg.role, preview: block.text.substring(0, 200), tokens, msgIndex });
              }
            } else if (block.type === 'thinking') {
              breakdown.thinking_blocks.tokens += estimateTokens(block.thinking);
              breakdown.thinking_blocks.content.push({ preview: (block.thinking || '').substring(0, 200), tokens: estimateTokens(block.thinking) });
            } else if (block.type === 'tool_use') {
              const tokens = estimateTokens(JSON.stringify(block));
              breakdown.tool_calls.tokens += tokens;
              breakdown.tool_calls.count++;
              breakdown.tool_calls.content.push({ name: block.name, id: block.id, tokens, msgIndex });
            } else if (block.type === 'tool_result') {
              const resultStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
              const tokens = estimateTokens(resultStr);
              breakdown.tool_results.tokens += tokens;
              breakdown.tool_results.count++;
              breakdown.tool_results.content.push({
                tool_use_id: block.tool_use_id,
                preview: resultStr.substring(0, 300),
                tokens,
                fullLength: resultStr.length,
                msgIndex,
                hasHtml: detectHtml(resultStr),
                hasRoleConfusion: detectRoleConfusion(resultStr),
              });
            } else if (block.type === 'image') {
              breakdown.media.count++;
              if (block.source && block.source.data) {
                breakdown.media.tokens += Math.ceil(block.source.data.length / 4);
              }
            }
          }
          if (msg.role === 'user') breakdown.user_text.messageCount++;
        }
      }
    }
  }
}

function parseOpenAIRequest(body, breakdown) {
  if (body.messages && Array.isArray(body.messages)) {
    let msgIndex = 0;
    for (const msg of body.messages) {
      msgIndex++;
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        breakdown.system_prompts.tokens += estimateTokens(text);
        breakdown.system_prompts.content.push({ type: 'text', text: text.substring(0, 500), fullLength: text.length });
      } else if (msg.role === 'tool') {
        const resultStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const tokens = estimateTokens(resultStr);
        breakdown.tool_results.tokens += tokens;
        breakdown.tool_results.count++;
        breakdown.tool_results.content.push({
          tool_call_id: msg.tool_call_id,
          preview: resultStr.substring(0, 300),
          tokens,
          fullLength: resultStr.length,
          msgIndex,
          hasHtml: detectHtml(resultStr),
          hasRoleConfusion: detectRoleConfusion(resultStr),
        });
      } else if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        breakdown.assistant_text.tokens += estimateTokens(text);
        breakdown.assistant_text.content.push({ role: msg.role, preview: (text || '').substring(0, 200), tokens: estimateTokens(text), msgIndex });

        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const tokens = estimateTokens(JSON.stringify(tc));
            breakdown.tool_calls.tokens += tokens;
            breakdown.tool_calls.count++;
            breakdown.tool_calls.content.push({ name: tc.function?.name || 'unknown', id: tc.id, tokens, msgIndex });
          }
        }

        if (msg.content && Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'image_url') {
              breakdown.media.count++;
              if (part.image_url && part.image_url.url && part.image_url.url.startsWith('data:')) {
                breakdown.media.tokens += Math.ceil(part.image_url.url.length / 4);
              }
            }
          }
        }
      } else if (msg.role === 'user') {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        breakdown.user_text.tokens += estimateTokens(text);
        breakdown.user_text.messageCount++;
        breakdown.user_text.content.push({ role: msg.role, preview: (text || '').substring(0, 200), tokens: estimateTokens(text), msgIndex });
      }
    }
  }

  if (body.tools && Array.isArray(body.tools)) {
    breakdown.tool_definitions.count = body.tools.length;
    const toolsStr = JSON.stringify(body.tools);
    breakdown.tool_definitions.tokens = estimateTokens(toolsStr);
    breakdown.tool_definitions.content = body.tools.map(t => ({
      name: t.function ? t.function.name : 'unknown',
      tokens: estimateTokens(JSON.stringify(t)),
    }));
  }
}

function parseGoogleRequest(body, breakdown) {
  if (body.systemInstruction) {
    const text = JSON.stringify(body.systemInstruction);
    breakdown.system_prompts.tokens = estimateTokens(text);
    breakdown.system_prompts.content.push({ type: 'text', text: text.substring(0, 500), fullLength: text.length });
  }

  if (body.tools && Array.isArray(body.tools)) {
    const toolsStr = JSON.stringify(body.tools);
    breakdown.tool_definitions.tokens = estimateTokens(toolsStr);
    breakdown.tool_definitions.count = body.tools.reduce((acc, t) => acc + (t.functionDeclarations ? t.functionDeclarations.length : 0), 0);
    breakdown.tool_definitions.content = [];
    for (const tool of body.tools) {
      if (tool.functionDeclarations) {
        for (const fd of tool.functionDeclarations) {
          breakdown.tool_definitions.content.push({ name: fd.name, tokens: estimateTokens(JSON.stringify(fd)) });
        }
      }
    }
  }

  if (body.contents && Array.isArray(body.contents)) {
    let msgIndex = 0;
    for (const content of body.contents) {
      msgIndex++;
      if (content.parts) {
        for (const part of content.parts) {
          if (part.text) {
            const tokens = estimateTokens(part.text);
            const role = content.role || 'user';
            if (role === 'model') {
              breakdown.assistant_text.tokens += tokens;
              breakdown.assistant_text.content.push({ role, preview: part.text.substring(0, 200), tokens, msgIndex });
            } else {
              breakdown.user_text.tokens += tokens;
              breakdown.user_text.messageCount++;
              breakdown.user_text.content.push({ role, preview: part.text.substring(0, 200), tokens, msgIndex });
            }
          }
          if (part.functionCall) {
            const tokens = estimateTokens(JSON.stringify(part.functionCall));
            breakdown.tool_calls.tokens += tokens;
            breakdown.tool_calls.count++;
            breakdown.tool_calls.content.push({ name: part.functionCall.name, tokens, msgIndex });
          }
          if (part.functionResponse) {
            const resultStr = JSON.stringify(part.functionResponse);
            const tokens = estimateTokens(resultStr);
            breakdown.tool_results.tokens += tokens;
            breakdown.tool_results.count++;
            breakdown.tool_results.content.push({
              name: part.functionResponse.name,
              preview: resultStr.substring(0, 300),
              tokens,
              msgIndex,
              hasHtml: detectHtml(resultStr),
              hasRoleConfusion: detectRoleConfusion(resultStr),
            });
          }
          if (part.inlineData) {
            breakdown.media.count++;
            breakdown.media.tokens += Math.ceil((part.inlineData.data || '').length / 4);
          }
        }
      }
    }
  }
}

function detectHtml(text) {
  if (!text || text.length < 10) return false;
  const htmlPatterns = [
    /<!--[\s\S]*?-->/,
    /<(div|span|table|tr|td|th|ul|ol|li|p|h[1-6]|section|article|header|footer|nav|main|form|input|button|script|style|link|meta|head|body|html)\b/i,
    /<\/[a-z]+>/i,
  ];
  return htmlPatterns.some(p => p.test(text));
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
  return confusionPatterns.some(p => p.test(text));
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

function extractModel(body, response, provider) {
  if (body.model) return body.model;
  if (response && response.body && response.body.model) return response.body.model;
  return 'unknown';
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
    } else if (provider === 'openai') {
      const cached = body.usage.prompt_tokens_details?.cached_tokens || 0;
      return {
        input: body.usage.prompt_tokens || 0,
        output: body.usage.completion_tokens || 0,
        cacheRead: cached,
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

module.exports = { parseRequest, estimateTokens, detectAgent };
