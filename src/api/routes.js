const express = require('express');
const { calculateCost, MODEL_PRICING } = require('../cost/pricing');
const { generateFindings } = require('../findings/findings');
const { parseRequest } = require('../parser/parser');

function createAPIRouter(storage) {
  const router = express.Router();

  router.post('/simulate', (req, res) => {
    const { provider, request: simReq } = req.body;
    if (!provider || !simReq) return res.status(400).json({ error: 'Missing provider or request' });

    const capture = {
      provider,
      timestamp: Date.now(),
      request: {
        method: 'POST',
        path: provider === 'anthropic' ? '/v1/messages' : provider === 'openai' ? '/v1/chat/completions' : '/v1beta/models/gemini/generateContent',
        headers: simReq.headers || {},
        body: simReq.body,
      },
      response: {
        statusCode: 200,
        headers: {},
        body: simReq.response || null,
      },
      isStreaming: false,
    };

    const breakdown = parseRequest(capture);
    const result = storage.addCapture(capture, breakdown);
    res.json({ ...result, breakdown });
  });

  router.get('/sessions', (req, res) => {
    const sessions = storage.getSessions();
    const enriched = sessions.map(session => {
      const cacheTokens = extractSessionCacheTokens(storage.getSessionCaptures(session.id));
      const cost = calculateCost(session.totalInputTokens, session.totalOutputTokens, session.model, cacheTokens);
      return {
        ...session,
        cost,
        turnBreakdowns: undefined,
      };
    });
    res.json(enriched);
  });

  router.get('/sessions/:id', (req, res) => {
    const session = storage.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const captures = storage.getSessionCaptures(req.params.id);
    const cacheTokens = extractSessionCacheTokens(captures);
    const cost = calculateCost(session.totalInputTokens, session.totalOutputTokens, session.model, cacheTokens);
    const findings = generateFindings(session, captures);

    res.json({
      ...session,
      cost,
      findings,
      captureCount: captures.length,
    });
  });

  router.get('/sessions/:id/captures', (req, res) => {
    const session = storage.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const captures = storage.getSessionCaptures(req.params.id);
    res.json(captures.map(c => ({
      id: c.id,
      timestamp: c.timestamp,
      provider: c.provider,
      model: c.model,
      agent: c.agent,
      isStreaming: c.isStreaming,
      breakdown: c.breakdown ? {
        total_tokens: c.breakdown.total_tokens,
        system_prompts: { tokens: c.breakdown.system_prompts.tokens, percentage: c.breakdown.system_prompts.percentage, token_method: c.breakdown.system_prompts.token_method, token_confidence: c.breakdown.system_prompts.token_confidence },
        tool_definitions: { tokens: c.breakdown.tool_definitions.tokens, percentage: c.breakdown.tool_definitions.percentage, count: c.breakdown.tool_definitions.count, token_method: c.breakdown.tool_definitions.token_method, token_confidence: c.breakdown.tool_definitions.token_confidence },
        tool_calls: { tokens: c.breakdown.tool_calls.tokens, percentage: c.breakdown.tool_calls.percentage, count: c.breakdown.tool_calls.count, token_method: c.breakdown.tool_calls.token_method, token_confidence: c.breakdown.tool_calls.token_confidence },
        tool_results: { tokens: c.breakdown.tool_results.tokens, percentage: c.breakdown.tool_results.percentage, count: c.breakdown.tool_results.count, token_method: c.breakdown.tool_results.token_method, token_confidence: c.breakdown.tool_results.token_confidence },
        assistant_text: { tokens: c.breakdown.assistant_text.tokens, percentage: c.breakdown.assistant_text.percentage, token_method: c.breakdown.assistant_text.token_method, token_confidence: c.breakdown.assistant_text.token_confidence },
        user_text: { tokens: c.breakdown.user_text.tokens, percentage: c.breakdown.user_text.percentage, messageCount: c.breakdown.user_text.messageCount, token_method: c.breakdown.user_text.token_method, token_confidence: c.breakdown.user_text.token_confidence },
        thinking_blocks: { tokens: c.breakdown.thinking_blocks.tokens, percentage: c.breakdown.thinking_blocks.percentage, token_method: c.breakdown.thinking_blocks.token_method, token_confidence: c.breakdown.thinking_blocks.token_confidence },
        media: { tokens: c.breakdown.media.tokens, percentage: c.breakdown.media.percentage, count: c.breakdown.media.count, token_method: c.breakdown.media.token_method, token_confidence: c.breakdown.media.token_confidence },
        model: c.breakdown.model,
        response_tokens: c.breakdown.response_tokens,
      } : null,
      request: c.request,
      response: c.response,
    })));
  });

  router.get('/sessions/:id/capture/:captureId', (req, res) => {
    const capture = storage.getCaptureDetail(req.params.captureId);
    if (!capture) return res.status(404).json({ error: 'Capture not found' });
    if (capture.sessionId !== req.params.id) return res.status(404).json({ error: 'Capture not found in session' });
    res.json(capture);
  });

  router.get('/sessions/:id/composition', (req, res) => {
    const captures = storage.getSessionCaptures(req.params.id);
    if (captures.length === 0) return res.json({ composition: null });

    const rawTurn = req.query.turn !== undefined ? parseInt(req.query.turn, 10) : captures.length - 1;
    const turnIdx = Number.isNaN(rawTurn) ? captures.length - 1 : rawTurn;
    const capture = captures[Math.min(Math.max(0, turnIdx), captures.length - 1)];
    if (!capture || !capture.breakdown) return res.json({ composition: null });

    const b = capture.breakdown;
    const cost = calculateCost(b.total_tokens, b.response_tokens ? b.response_tokens.output : 0, b.model);

    const messageCount = (b.user_text.messageCount || 0) +
      (b.assistant_text.content ? b.assistant_text.content.length : 0) +
      (b.tool_calls.count || 0) +
      (b.tool_results.count || 0);

    res.json({
      composition: {
        categories: [
          { name: 'System Prompts', key: 'system_prompts', tokens: b.system_prompts.tokens, percentage: b.system_prompts.percentage, color: '#6366f1', token_method: b.system_prompts.token_method, token_confidence: b.system_prompts.token_confidence },
          { name: 'Tool Definitions', key: 'tool_definitions', tokens: b.tool_definitions.tokens, percentage: b.tool_definitions.percentage, color: '#f59e0b', token_method: b.tool_definitions.token_method, token_confidence: b.tool_definitions.token_confidence },
          { name: 'Tool Calls', key: 'tool_calls', tokens: b.tool_calls.tokens, percentage: b.tool_calls.percentage, color: '#ef4444', token_method: b.tool_calls.token_method, token_confidence: b.tool_calls.token_confidence },
          { name: 'Tool Results', key: 'tool_results', tokens: b.tool_results.tokens, percentage: b.tool_results.percentage, color: '#10b981', token_method: b.tool_results.token_method, token_confidence: b.tool_results.token_confidence },
          { name: 'Assistant Text', key: 'assistant_text', tokens: b.assistant_text.tokens, percentage: b.assistant_text.percentage, color: '#f97316', token_method: b.assistant_text.token_method, token_confidence: b.assistant_text.token_confidence },
          { name: 'User Text', key: 'user_text', tokens: b.user_text.tokens, percentage: b.user_text.percentage, color: '#06b6d4', token_method: b.user_text.token_method, token_confidence: b.user_text.token_confidence },
          { name: 'Thinking', key: 'thinking_blocks', tokens: b.thinking_blocks.tokens, percentage: b.thinking_blocks.percentage, color: '#a855f7', token_method: b.thinking_blocks.token_method, token_confidence: b.thinking_blocks.token_confidence },
          { name: 'Media', key: 'media', tokens: b.media.tokens, percentage: b.media.percentage, color: '#ec4899', token_method: b.media.token_method, token_confidence: b.media.token_confidence },
        ],
        total_tokens: b.total_tokens,
        model: b.model,
        cost,
        turn: turnIdx,
        messageCount,
        token_counting: b.token_counting,
      },
    });
  });

  router.get('/sessions/:id/timeline', (req, res) => {
    const timeline = storage.getTimeline(req.params.id);
    const session = storage.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const enriched = timeline.map(turn => {
      const cost = calculateCost(turn.breakdown.total, 0, turn.model);
      return { ...turn, cost };
    });

    res.json(enriched);
  });

  router.get('/sessions/:id/diffs', (req, res) => {
    const timeline = storage.getTimeline(req.params.id);
    const diffs = timeline.map(turn => ({
      captureId: turn.captureId,
      timestamp: turn.timestamp,
      diff: turn.diff,
      model: turn.model,
    }));
    res.json(diffs);
  });

  router.get('/sessions/:id/findings', (req, res) => {
    const session = storage.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const captures = storage.getSessionCaptures(req.params.id);
    const findings = generateFindings(session, captures);
    res.json(findings);
  });

  router.get('/sessions/:id/export', (req, res) => {
    const lhar = storage.exportLHAR(req.params.id);
    if (!lhar) return res.status(404).json({ error: 'Session not found' });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=context-review-${req.params.id}.lhar.json`);
    res.json(lhar);
  });

  router.get('/stats', (req, res) => {
    const sessions = storage.getSessions();
    let totalRequests = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;

    for (const session of sessions) {
      totalRequests += session.requestCount;
      totalInputTokens += session.totalInputTokens;
      totalOutputTokens += session.totalOutputTokens;
      const cacheTokens = extractSessionCacheTokens(storage.getSessionCaptures(session.id));
      const cost = calculateCost(session.totalInputTokens, session.totalOutputTokens, session.model, cacheTokens);
      totalCost += cost.totalCost;
    }

    res.json({
      sessionCount: sessions.length,
      totalRequests,
      totalInputTokens,
      totalOutputTokens,
      totalCost: Math.round(totalCost * 1000000) / 1000000,
      models: MODEL_PRICING,
    });
  });

  router.delete('/sessions', (req, res) => {
    storage.clearAll();
    res.json({ success: true });
  });

  return router;
}

function extractSessionCacheTokens(captures) {
  let totalRead = 0;
  let totalCreation = 0;
  for (const c of captures) {
    if (c.breakdown?.response_tokens) {
      totalRead += c.breakdown.response_tokens.cacheRead || 0;
      totalCreation += c.breakdown.response_tokens.cacheCreation || 0;
    }
  }
  if (totalRead === 0 && totalCreation === 0) return null;
  return { read: totalRead, creation: totalCreation };
}

module.exports = { createAPIRouter };
