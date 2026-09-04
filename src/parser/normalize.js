const { stringifyValue } = require('../tokens/counter');
const NORMALIZED_SCHEMA_VERSION = '1.0.0';
const SUPPORTED_SCHEMA_MAJOR = 1;
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
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
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
  if (!normalized.schemaVersion || typeof normalized.schemaVersion !== 'string') {
    return { ok: false, error: 'schemaVersion is required' };
  }
  if (!/^\d+\.\d+\.\d+$/.test(normalized.schemaVersion)) {
    return { ok: false, error: 'schemaVersion must be semver-like' };
  }
  const compatibility = resolveSchemaCompatibility(normalized.schemaVersion);
  if (!compatibility.ok) return compatibility;
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

function ensureNormalizedCompatibility(normalized) {
  if (!normalized || typeof normalized !== 'object') {
    return { ok: false, error: 'normalized capture must be an object' };
  }

  const output = {
    ...normalized,
    schemaVersion: normalized.schemaVersion || NORMALIZED_SCHEMA_VERSION,
    systemPrompts: Array.isArray(normalized.systemPrompts) ? normalized.systemPrompts : [],
    toolDefinitions: Array.isArray(normalized.toolDefinitions) ? normalized.toolDefinitions : [],
    messages: Array.isArray(normalized.messages) ? normalized.messages : [],
    items: Array.isArray(normalized.items) ? normalized.items : [],
  };

  const check = validateNormalizedCapture(output);
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true, normalized: output };
}

function resolveSchemaCompatibility(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    return { ok: false, error: 'schemaVersion must be semver-like' };
  }
  const major = Number(version.split('.')[0]);
  if (major !== SUPPORTED_SCHEMA_MAJOR) {
    return {
      ok: false,
      error: `schemaVersion major ${major} is not supported (expected ${SUPPORTED_SCHEMA_MAJOR}.x.x)`,
    };
  }
  return { ok: true, major };
}

function buildSchemaMigrationChecklist(normalized, targetVersion = '2.0.0') {
  const currentVersion = String(normalized?.schemaVersion || NORMALIZED_SCHEMA_VERSION);
  const currentMajor = Number(currentVersion.split('.')[0]);
  const target = String(targetVersion || '2.0.0');
  const targetMajor = Number(target.split('.')[0]);
  const currentSupported = Number.isFinite(currentMajor) && currentMajor === SUPPORTED_SCHEMA_MAJOR;
  const targetSupported = Number.isFinite(targetMajor) && targetMajor === SUPPORTED_SCHEMA_MAJOR;
  const hasRequiredShape = Boolean(normalized && typeof normalized === 'object' && Array.isArray(normalized.systemPrompts) && Array.isArray(normalized.toolDefinitions) && Array.isArray(normalized.messages) && Array.isArray(normalized.items));

  return {
    currentVersion,
    currentMajor: Number.isFinite(currentMajor) ? currentMajor : null,
    targetVersion: target,
    targetMajor: Number.isFinite(targetMajor) ? targetMajor : null,
    currentSupported,
    targetSupported,
    canAutoMigrate: currentSupported && targetSupported && hasRequiredShape,
    preservesUnknownFields: true,
    checklist: [
      'Preserve source references and raw payloads during normalization.',
      'Keep category mapping stable across provider adapters.',
      'Add an explicit migration adapter for any new major schema version.',
      'Validate that arrays and nested content survive round-trip serialization.',
      'Add golden fixtures before flipping the supported major version.',
    ],
    notes: [
      currentSupported ? 'Current schema major is supported.' : `Current schema major ${currentMajor} is outside the supported major ${SUPPORTED_SCHEMA_MAJOR}.`,
      targetSupported ? 'Target schema major is already supported.' : `Target schema major ${targetMajor} will require a migration layer.`,
    ],
  };
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
        name: tool.function?.name || tool.name || 'unknown',
        raw: tool,
        source: sourceRef({ provider: 'openai', msgIndex: 0, partIndex: index, role: 'system', path: `tools[${index}]` }),
      });
    });
  }

  if (typeof body.instructions === 'string' && body.instructions) {
    pushSystemPrompt(normalized, body.instructions, sourceRef({ provider: 'openai', msgIndex: 0, partIndex: 0, role: 'system', path: 'instructions' }));
  }

  if (!Array.isArray(body.messages)) {
    normalizeOpenAIResponsesInput(body, normalized);
    return;
  }
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

function normalizeOpenAIResponsesInput(body, normalized) {
  // OpenAI Responses API (/v1/responses): `instructions` + `input` instead of `messages`.
  const input = body.input;
  if (typeof input === 'string' && input) {
    pushMessageItem(normalized, {
      category: 'user_text',
      role: 'user',
      text: input,
      raw: input,
      name: null,
      source: sourceRef({ provider: 'openai', role: 'user', msgIndex: 1, partIndex: 0, path: 'input' }),
    });
    return;
  }
  if (!Array.isArray(input)) return;
  input.forEach((item, index) => {
    const msgIndex = index + 1;
    if (!item || typeof item !== 'object') return;
    if (item.type === 'function_call') {
      pushMessageItem(normalized, {
        category: 'tool_calls',
        role: 'assistant',
        text: stringifyValue(item),
        raw: item,
        name: item.name || 'unknown',
        id: item.call_id || item.id,
        source: sourceRef({ provider: 'openai', role: 'assistant', msgIndex, partIndex: 0, path: `input[${index}]` }),
      });
      return;
    }
    if (item.type === 'function_call_output') {
      pushMessageItem(normalized, {
        category: 'tool_results',
        role: 'tool',
        text: stringifyValue(item.output),
        raw: item.output,
        name: null,
        toolCallId: item.call_id,
        source: sourceRef({ provider: 'openai', role: 'tool', msgIndex, partIndex: 0, path: `input[${index}]` }),
      });
      return;
    }
    const role = item.role || 'user';
    pushMessageItem(normalized, {
      category: role === 'assistant' ? 'assistant_text' : 'user_text',
      role,
      text: stringifyValue(item.content !== undefined ? item.content : item),
      raw: item.content !== undefined ? item.content : item,
      name: null,
      source: sourceRef({ provider: 'openai', role, msgIndex, partIndex: 0, path: `input[${index}]` }),
    });
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

module.exports = {
  NORMALIZED_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_MAJOR,
  normalizeCapture,
  validateNormalizedCapture,
  ensureNormalizedCompatibility,
  resolveSchemaCompatibility,
  buildSchemaMigrationChecklist,
};
