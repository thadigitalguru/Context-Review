const { getContextWindow } = require('../cost/pricing');
const { countTokens, stringifyValue } = require('../tokens/counter');

function generateFindings(session, captures) {
  const findings = [];

  if (!session || !captures || captures.length === 0) return findings;

  const lastCapture = captures[captures.length - 1];
  const breakdown = lastCapture.breakdown;
  if (!breakdown) return findings;

  const contextWindow = getContextWindow(breakdown.model);
  const usagePercent = (breakdown.total_tokens / contextWindow) * 100;

  if (usagePercent > 80) {
    findings.push({
      type: 'critical',
      category: 'overflow',
      severity: 'critical',
      title: `Context utilization critical: ${Math.round(usagePercent)}%`,
      description: `${formatTokens(breakdown.total_tokens)} of ${formatTokens(contextWindow)} tokens. Overflow risk is elevated, and older messages may be dropped or summarized.`,
      suggestion: 'Start a new session or reduce context by removing conversation history.',
      usage: { current: breakdown.total_tokens, max: contextWindow, percent: Math.round(usagePercent) },
      estimatedSavings: {
        tokens: Math.round(breakdown.total_tokens - (contextWindow * 0.5)),
        confidence: 'moderate',
      },
    });
  } else if (usagePercent > 50) {
    const remainingTokens = contextWindow - breakdown.total_tokens;
    const avgPerTurn = session.totalInputTokens / Math.max(session.requestCount, 1);
    const estimatedTurnsLeft = avgPerTurn > 0 ? Math.floor(remainingTokens / avgPerTurn) : 0;

    findings.push({
      type: 'info',
      category: 'overflow',
      severity: 'low',
      title: `Context utilization elevated: ${Math.round(usagePercent)}%`,
      description: `Using ${formatTokens(breakdown.total_tokens)} of ${formatTokens(contextWindow)} tokens. At current rate, approximately ${estimatedTurnsLeft} turns remaining before overflow.`,
      suggestion: 'Monitor context growth. Consider starting a new session if working on a long task.',
      usage: { current: breakdown.total_tokens, max: contextWindow, percent: Math.round(usagePercent), estimatedTurnsLeft },
      estimatedSavings: {
        tokens: Math.max(0, Math.round(breakdown.total_tokens - (contextWindow * 0.5))),
        confidence: 'moderate',
      },
    });
  }

  if (breakdown.tool_results.content && breakdown.tool_results.content.length > 0) {
    const htmlResults = breakdown.tool_results.content.filter(r => r.hasHtml);
    for (const r of htmlResults) {
      const toolName = r.tool_use_id || r.name || 'unknown';
      findings.push({
        type: 'warning',
        category: 'tool_results',
        severity: 'medium',
        title: `html hidden text in tool result: Read (msg ${r.msgIndex || '?'})`,
        description: r.preview ? r.preview.substring(0, 120) : 'HTML content detected in tool result that may contain hidden tokens.',
        suggestion: 'Strip HTML tags from tool results to reduce token waste from markup.',
        preview: r.preview,
        msgIndex: r.msgIndex,
        source: r.source,
        estimatedSavings: estimateHtmlSavings(r),
      });
    }

    const confusionResults = breakdown.tool_results.content.filter(r => r.hasRoleConfusion);
    for (const r of confusionResults) {
      findings.push({
        type: 'warning',
        category: 'tool_results',
        severity: 'medium',
        title: `role confusion in tool result: Read (msg ${r.msgIndex || '?'})`,
        description: r.preview ? r.preview.substring(0, 120) : 'Tool result contains text that may confuse the model about its role.',
        suggestion: 'Sanitize tool results to remove instruction-like text that may cause role confusion.',
        preview: r.preview,
        msgIndex: r.msgIndex,
        source: r.source,
        estimatedSavings: {
          tokens: Math.round(r.tokens * 0.15),
          confidence: 'low',
        },
      });
    }
  }

  if (breakdown.tool_definitions.percentage > 30) {
    findings.push({
      type: 'warning',
      category: 'tool_definitions',
      severity: 'high',
      title: 'Tool definitions are consuming significant context',
      description: `Tool definitions take up ${breakdown.tool_definitions.percentage}% of your context (${formatTokens(breakdown.tool_definitions.tokens)} tokens). Consider reducing the number of tools or simplifying their schemas.`,
      suggestion: 'Review which tools are actually being used in this session and consider removing unused ones.',
      tokens: breakdown.tool_definitions.tokens,
      sources: breakdown.tool_definitions.content.map((tool) => ({ name: tool.name, source: tool.source, tokens: tool.tokens })),
      estimatedSavings: {
        tokens: Math.round(breakdown.tool_definitions.tokens * 0.3),
        confidence: 'moderate',
      },
    });
  }

  const unusedTools = findUnusedTools(captures);
  if (unusedTools.length > 0) {
    const unusedToolNames = unusedTools.map((tool) => tool.name);
    const totalUnusedTokens = unusedTools.reduce((sum, tool) => sum + tool.tokens, 0);
    findings.push({
      type: 'optimization',
      category: 'tool_definitions',
      severity: 'medium',
      title: `${unusedTools.length} tool definition(s) never used`,
      description: `The following tools were defined but never called: ${unusedToolNames.join(', ')}. Each consumes context tokens without providing value.`,
      suggestion: 'Configure your agent to load tools dynamically or remove unused tool definitions.',
      tools: unusedTools,
      estimatedSavings: {
        tokens: totalUnusedTokens,
        confidence: 'high',
      },
    });
  }

  const largeResults = findLargeToolResults(breakdown);
  if (largeResults.length > 0) {
    for (const r of largeResults) {
      findings.push({
        type: 'warning',
        category: 'tool_results',
        severity: 'high',
        title: `Large tool result (msg ${r.msgIndex || '?'}): ${formatTokens(r.tokens)} tokens`,
        description: `Tool result exceeded 2,000 tokens (${formatTokens(r.tokens)}). ${r.preview ? r.preview.substring(0, 80) + '...' : 'Large results consume context rapidly.'}`,
        suggestion: 'Consider truncating tool outputs, summarizing file contents, or paginating results.',
        preview: r.preview,
        msgIndex: r.msgIndex,
        source: r.source,
        estimatedSavings: {
          tokens: Math.max(0, r.tokens - 1000),
          confidence: 'moderate',
        },
      });
    }
  }

  if (breakdown.thinking_blocks.percentage > 20) {
    findings.push({
      type: 'info',
      category: 'thinking',
      severity: 'medium',
      title: 'Thinking blocks consuming significant context',
      description: `Thinking/reasoning blocks use ${breakdown.thinking_blocks.percentage}% of context (${formatTokens(breakdown.thinking_blocks.tokens)} tokens). These are cached in conversation history.`,
      suggestion: 'If using extended thinking, note that previous thinking blocks add to context. Consider shorter sessions.',
      tokens: breakdown.thinking_blocks.tokens,
      sources: breakdown.thinking_blocks.content.map((block) => ({ source: block.source, tokens: block.tokens })),
      estimatedSavings: {
        tokens: Math.round(breakdown.thinking_blocks.tokens * 0.25),
        confidence: 'low',
      },
    });
  }

  if (breakdown.system_prompts.percentage > 25) {
    findings.push({
      type: 'optimization',
      category: 'system_prompts',
      severity: 'medium',
      title: 'System prompts are large',
      description: `System prompts take ${breakdown.system_prompts.percentage}% of context (${formatTokens(breakdown.system_prompts.tokens)} tokens).`,
      suggestion: 'Review system prompts for unnecessary instructions or examples that could be moved to tool descriptions or separate documentation.',
      tokens: breakdown.system_prompts.tokens,
      sources: breakdown.system_prompts.content.map((prompt) => ({ source: prompt.source, tokens: prompt.tokens })),
      estimatedSavings: {
        tokens: Math.round(breakdown.system_prompts.tokens * 0.2),
        confidence: 'moderate',
      },
    });
  }

  if (session.turnBreakdowns && session.turnBreakdowns.length >= 2) {
    const diffs = session.turnBreakdowns.slice(-5);
    const growthRates = [];
    for (let i = 1; i < diffs.length; i++) {
      if (diffs[i].diff && diffs[i].diff.total) {
        growthRates.push(diffs[i].diff.total.delta);
      }
    }

    if (growthRates.length > 0) {
      const avgGrowth = growthRates.reduce((a, b) => a + b, 0) / growthRates.length;
      if (avgGrowth > 5000) {
        findings.push({
          type: 'warning',
          category: 'growth',
          severity: 'medium',
          title: 'Rapid context growth detected',
          description: `Context is growing by ~${formatTokens(Math.round(avgGrowth))} tokens per turn. At this rate, you'll hit limits quickly.`,
          suggestion: 'Check for growing tool results, repeated tool calls, or accumulated thinking blocks.',
          avgGrowth: Math.round(avgGrowth),
          estimatedSavings: {
            tokens: Math.round(avgGrowth),
            confidence: 'low',
          },
        });
      }
    }

    const lastTwo = session.turnBreakdowns.slice(-2);
    if (lastTwo.length === 2 && lastTwo[1].breakdown.total < lastTwo[0].breakdown.total * 0.7) {
      findings.push({
        type: 'info',
        category: 'compaction',
        severity: 'low',
        title: 'Context compaction detected',
        description: `Context shrank by ${formatTokens(lastTwo[0].breakdown.total - lastTwo[1].breakdown.total)} tokens between turns. The agent may have truncated history.`,
        suggestion: 'Compaction is normal but may cause loss of earlier context. Review what was dropped.',
        estimatedSavings: {
          tokens: lastTwo[0].breakdown.total - lastTwo[1].breakdown.total,
          confidence: 'high',
        },
      });
    }
  }

  if (breakdown.media.count > 0) {
    findings.push({
      type: 'info',
      category: 'media',
      severity: 'low',
      title: `${breakdown.media.count} media item(s) in context`,
      description: `Images/media use ~${formatTokens(breakdown.media.tokens)} tokens. Consider whether all images are needed.`,
      suggestion: 'Resize images or remove unnecessary visual content to save tokens.',
      estimatedSavings: {
        tokens: Math.round(breakdown.media.tokens * 0.5),
        confidence: 'low',
      },
    });
  }

  return findings;
}

function findUnusedTools(captures) {
  const allDefined = new Map();
  const allCalled = new Set();

  for (const capture of captures) {
    if (capture.breakdown && capture.breakdown.tool_definitions.content) {
      for (const tool of capture.breakdown.tool_definitions.content) {
        if (!allDefined.has(tool.name)) {
          allDefined.set(tool.name, {
            name: tool.name,
            tokens: tool.tokens || 0,
            source: tool.source,
          });
        }
      }
    }
    if (capture.breakdown && capture.breakdown.tool_calls && capture.breakdown.tool_calls.content) {
      for (const tc of capture.breakdown.tool_calls.content) {
        if (tc.name) allCalled.add(tc.name);
      }
    }
  }

  return [...allDefined.values()].filter((tool) => !allCalled.has(tool.name));
}

function findLargeToolResults(breakdown) {
  if (!breakdown.tool_results.content) return [];
  return breakdown.tool_results.content
    .filter(r => r.tokens > 2000)
    .map(r => ({ ...r }));
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function estimateHtmlSavings(result) {
  const previewText = stringifyValue(result.preview || '');
  const stripped = previewText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const before = countTokens(previewText, { label: 'tool_result_html' }).tokens;
  const after = countTokens(stripped, { label: 'tool_result_html' }).tokens;
  return {
    tokens: Math.max(0, before - after),
    confidence: 'moderate',
  };
}

module.exports = { generateFindings };
