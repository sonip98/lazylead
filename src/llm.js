// Minimal Ollama client. Every call asks for JSON that matches a schema,
// so the rest of the code can treat the model like a function.

export function createOllama({ url = 'http://127.0.0.1:11434', model, numCtx = 8192, fetchImpl = fetch } = {}) {
  const stats = { calls: 0, promptTokens: 0, outputTokens: 0, ms: 0 };

  async function json(system, user, schema) {
    const started = Date.now();
    const res = await fetchImpl(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: schema,
        options: { temperature: 0.2, num_ctx: numCtx },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    stats.calls++;
    stats.promptTokens += data.prompt_eval_count || 0;
    stats.outputTokens += data.eval_count || 0;
    stats.ms += Date.now() - started;
    return JSON.parse(data.message.content);
  }

  return { model, json, stats };
}
