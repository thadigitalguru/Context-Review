const { stringifyValue } = require('../tokens/counter');
const NORMALIZED_CATEGORIES = new Set([
  'assistant_text',
  'user_text',
  'tool_calls',
  'tool_results',
  'thinking_blocks',
  'media',
]);

function normalizeCapture(capture) {
  const provider = capture.provider;
  const body = capture.request?.body;
  if (!body) return null;

  const normalized = {
    provider,
    model: extractModel(body, capture.response, provider),
    systemPrompts: [],
    toolDefinitions: [],
    messages: [],
    items: [],
  };

  if (provider === 'anthropic') {
    normalizeAnthropic(body, normalized);
  } else if (provider === 'openai') {
    normalizeOpenAI(body, normalized);
  } else if (provider === 'google') {
    normalizeGoogle(body, normalized);
  } else {
    return null;
  }

  return normalized;
}

function validateNormalizedCapture(normalized) {
  if (!normalized || typeof normalized !== 'object') {
    return { ok: false, error: 'normalized capture must be an object' };
  }
  if (!normalized.provider || typeof normalized.provider !== 'string') {
    return { ok: false, error: 'provider is required' };
  }
  if (!normalized.model || typeof normalized.model !== 'string') {
    return { ok: false, error: 'model is required' };
  }
  if (!Array.isArray(normalized.systemPrompts) || !Array.isArray(normalized.toolDefinitions) ||
    !Array.isArray(normalized.messages) || !Array.isArray(normalized.items)) {
    return { ok: false, error: 'normalized arrays are required' };
  }

  for (const prompt of normalized.systemPrompts) {
    const check = validateNormalizedSystemPrompt(prompt);
    if (!check.ok) return check;
  }

  for (const tool of normalized.toolDefinitions) {
    const check = validateNormalizedToolDefinition(tool);
    if (!check.ok) return check;
  }

  for (const item of normalized.items) {
    const check = validateNormalizedItem(item);
    if (!check.ok) return check;
  }

  return { ok: true };
}

function normalizeAnthropic(body, normalized) {
  if (typeof body.system === 'string') {
    pushSystemPrompt(normalized, body.system, { role: 'system', msgIndex: 0, partIndex: 0, provider: 'anthropic', path: 'system' });
  } else if (Array.isArray(body.system)) {
    body.system.forEach((block, index) => {
      if (block.type === 'text') {
        pushSystemPrompt(normalized, block.text, { role: 'system', msgIndex: 0, partIndex: index, provider: 'anthropic', path: `system[${index}]` });
      }
    });
  }

  if (Array.isArray(body.tools)) {
    body.tools.forEach((tool, index) => {
      normalized.toolDefinitions.push({
        name: tool.name || 'unknown',
        raw: tool,
        source: sourceRef({ provider: 'anthropic', msgIndex: 0, partIndex: index, role: 'system', path: `tools[${index}]` }),
      });
    });
  }

  if (!Array.isArray(body.messages)) return;
  body.messages.forEach((msg, msgIndexZero) => {
    const msgIndex = msgIndexZero + 1;
    if (typeof msg.content === 'string') {
      pushMessageItem(normalized, {
        category: msg.role === 'assistant' ? 'assistant_text' : 'user_text',
        role: msg.role,
        text: msg.content,
        raw: msg.content,
        name: null,
        source: sourceRef({ provider: 'anthropic', role: msg.role, msgIndex, partIndex: 0, path: `messages[${msgIndexZero}]` }),
      });
      return;
    }

    if (!Array.isArray(msg.content)) return;
    msg.content.forEach((block, partIndex) => {
      const base = {
        provider: 'anthropic',
        role: msg.role,
        msgIndex,
        partIndex,
        path: `messages[${msgIndexZero}].content[${partIndex}]`,
      };

      if (block.type === 'text') {
        pushMessageItem(normalized, {
          category: msg.role === 'assistant' ? 'assistant_text' : 'user_text',
          role: msg.role,
          text: block.text,
          raw: block,
          name: null,
          source: sourceRef(base),
        });
      } else if (block.type === 'thinking') {
        pushMessageItem(normalized, {
          category: 'thinking_blocks',
          role: msg.role,
          text: block.thinking || '',
          raw: block,
          name: null,
          source: sourceRef(base),
        });
      } else if (block.type === 'tool_use') {
        pushMessageItem(normalized, {
          category: 'tool_calls',
          role: msg.role,
          text: stringifyValue(block),
          raw: block,
          name: block.name || 'unknown',
          id: block.id,
          source: sourceRef(base),
        });
      } else if (block.type === 'tool_result') {
        pushMessageItem(normalized, {
          category: 'tool_results',
          role: msg.role,
          text: stringifyValue(block.content),
          raw: block.content,
          name: block.name || null,
          toolUseId: block.tool_use_id,
          source: sourceRef(base),
        });
      } else if (block.type === 'image') {
        pushMessageItem(normalized, {
          category: 'media',
          role: msg.role,
          text: block.source?.data || '',
          raw: block,
          name: null,
          source: sourceRef(base),
        });
      }
    });
  });
}

function normalizeOpenAI(body, normalized) {
  if (Array.isArray(body.tools)) {
    body.tools.forEach((tool, index) => {
      normalized.toolDefinitions.push({
        name: tool.function?.name || 'unknown',
        raw: tool,
        source: sourceRef({ provider: 'openai', msgIndex: 0, partIndex: index, role: 'system', path: `tools[${index}]` }),
      });
    });
  }

  if (!Array.isArray(body.messages)) return;
  body.messages.forEach((msg, msgIndexZero) => {
    const msgIndex = msgIndexZero + 1;
    const base = {
      provider: 'openai',
      role: msg.role,
      msgIndex,
      path: `messages[${msgIndexZero}]`,
    };

    if (msg.role === 'system') {
      pushSystemPrompt(normalized, stringifyValue(msg.content), sourceRef({ ...base, partIndex: 0 }));
      return;
    }

    if (msg.role === 'tool') {
      pushMessageItem(normalized, {
        category: 'tool_results',
        role: msg.role,
        text: stringifyValue(msg.content),
        raw: msg.content,
        name: msg.name || null,
        toolCallId: msg.tool_call_id,
        source: sourceRef({ ...base, partIndex: 0 }),
      });
      return;
    }

    if (msg.role === 'assistant') {
      if (msg.content) {
        pushMessageItem(normalized, {
          category: 'assistant_text',
          role: msg.role,
          text: stringifyValue(msg.content),
          raw: msg.content,
          name: null,
          source: sourceRef({ ...base, partIndex: 0 }),
        });
      }

      if (Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach((toolCall, partIndex) => {
          pushMessageItem(normalized, {
            category: 'tool_calls',
            role: msg.role,
            text: stringifyValue(toolCall),
            raw: toolCall,
            name: toolCall.function?.name || 'unknown',
            id: toolCall.id,
            source: sourceRef({ ...base, partIndex, path: `messages[${msgIndexZero}].tool_calls[${partIndex}]` }),
          });
        });
      }

      if (Array.isArray(msg.content)) {
        msg.content.forEach((part, partIndex) => {
          if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
            pushMessageItem(normalized, {
              category: 'media',
              role: msg.role,
              text: part.image_url.url,
              raw: part,
              name: null,
              source: sourceRef({ ...base, partIndex, path: `messages[${msgIndexZero}].content[${partIndex}]` }),
            });
          }
        });
      }
      return;
    }

    if (msg.role === 'user') {
      pushMessageItem(normalized, {
        category: 'user_text',
        role: msg.role,
        text: stringifyValue(msg.content),
        raw: msg.content,
        name: null,
        source: sourceRef({ ...base, partIndex: 0 }),
      });
    }
  });
}

function normalizeGoogle(body, normalized) {
  if (body.systemInstruction) {
    pushSystemPrompt(normalized, stringifyValue(body.systemInstruction), {
      provider: 'google',
      role: 'system',
      msgIndex: 0,
      partIndex: 0,
      path: 'systemInstruction',
    });
  }

  if (Array.isArray(body.tools)) {
    body.tools.forEach((tool, toolIndex) => {
      (tool.functionDeclarations || []).forEach((declaration, index) => {
        normalized.toolDefinitions.push({
          name: declaration.name || 'unknown',
          raw: declaration,
          source: sourceRef({ provider: 'google', role: 'system', msgIndex: 0, partIndex: index, path: `tools[${toolIndex}].functionDeclarations[${index}]` }),
        });
      });
    });
  }

  if (!Array.isArray(body.contents)) return;
  body.contents.forEach((content, msgIndexZero) => {
    const msgIndex = msgIndexZero + 1;
    (content.parts || []).forEach((part, partIndex) => {
      const base = {
        provider: 'google',
        role: content.role || 'user',
        msgIndex,
        partIndex,
        path: `contents[${msgIndexZero}].parts[${partIndex}]`,
      };

      if (part.text) {
        pushMessageItem(normalized, {
          category: content.role === 'model' ? 'assistant_text' : 'user_text',
          role: content.role || 'user',
          text: part.text,
          raw: part.text,
          name: null,
          source: sourceRef(base),
        });
      }

      if (part.functionCall) {
        pushMessageItem(normalized, {
          category: 'tool_calls',
          role: content.role || 'user',
          text: stringifyValue(part.functionCall),
          raw: part.functionCall,
          name: part.functionCall.name || 'unknown',
          source: sourceRef(base),
        });
      }

      if (part.functionResponse) {
        pushMessageItem(normalized, {
          category: 'tool_results',
          role: content.role || 'user',
          text: stringifyValue(part.functionResponse),
          raw: part.functionResponse,
          name: part.functionResponse.name || 'unknown',
          source: sourceRef(base),
        });
      }

      if (part.inlineData) {
        pushMessageItem(normalized, {
          category: 'media',
          role: content.role || 'user',
          text: part.inlineData.data || '',
          raw: part.inlineData,
          name: null,
          source: sourceRef(base),
        });
      }
    });
  });
}

function pushSystemPrompt(normalized, text, source) {
  normalized.systemPrompts.push({ text, raw: text, source: sourceRef(source) });
}

function pushMessageItem(normalized, item) {
  const normalizedItem = {
    category: item.category,
    role: item.role || 'user',
    text: item.text || '',
    raw: item.raw,
    name: item.name || null,
    id: item.id || null,
    toolUseId: item.toolUseId || null,
    toolCallId: item.toolCallId || null,
    source: sourceRef(item.source),
  };
  normalized.messages.push(normalizedItem);
  normalized.items.push(normalizedItem);
}

function sourceRef(source) {
  return {
    provider: source.provider,
    role: source.role,
    msgIndex: source.msgIndex,
    partIndex: source.partIndex,
    path: source.path,
  };
}

function extractModel(body, response, provider) {
  if (body.model) return body.model;
  if (response && response.body && response.body.model) return response.body.model;
  return 'unknown';
}

function validateNormalizedSystemPrompt(prompt) {
  if (!prompt || typeof prompt !== 'object') return { ok: false, error: 'system prompt must be an object' };
  if (typeof prompt.text !== 'string') return { ok: false, error: 'system prompt text must be a string' };
  return validateSource(prompt.source);
}

function validateNormalizedToolDefinition(tool) {
  if (!tool || typeof tool !== 'object') return { ok: false, error: 'tool definition must be an object' };
  if (typeof tool.name !== 'string') return { ok: false, error: 'tool definition name must be a string' };
  return validateSource(tool.source);
}

function validateNormalizedItem(item) {
  if (!item || typeof item !== 'object') return { ok: false, error: 'item must be an object' };
  if (!NORMALIZED_CATEGORIES.has(item.category)) return { ok: false, error: `invalid category: ${item.category}` };
  if (typeof item.role !== 'string') return { ok: false, error: 'item role must be a string' };
  if (typeof item.text !== 'string') return { ok: false, error: 'item text must be a string' };
  return validateSource(item.source);
}

function validateSource(source) {
  if (!source || typeof source !== 'object') return { ok: false, error: 'source is required' };
  if (typeof source.provider !== 'string') return { ok: false, error: 'source provider must be a string' };
  if (typeof source.role !== 'string') return { ok: false, error: 'source role must be a string' };
  if (!Number.isFinite(source.msgIndex)) return { ok: false, error: 'source msgIndex must be numeric' };
  if (!Number.isFinite(source.partIndex)) return { ok: false, error: 'source partIndex must be numeric' };
  if (typeof source.path !== 'string') return { ok: false, error: 'source path must be a string' };
  return { ok: true };
}

module.exports = { normalizeCapture, validateNormalizedCapture };
