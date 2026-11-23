import { createRuntime, createTools } from './tools.mjs';

export const name = 'dsh-ai-wiki';

export const inject = ['tools', 'workingDirectory', 'systemPrompt'];

export function apply(ctx, config) {
  const runtime = createRuntime(ctx, config || {});

  for (const definition of createTools(runtime)) {
    ctx.tools.register(definition, {
      when: (context) => runtime.hasVaults(context && context.agent)
    });
  }

  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: 'aiwiki:vault',
      order: inner.systemPrompt.getSectionOrder('MCP_SERVERS') + 10,
      interpolate: false,
      text: (context) => runtime.promptText(context && context.agent)
    });
  });

  ctx.tools.guard((exec) => runtime.writeDenial(exec));

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => runtime.dispose());
  }
}
