import type { ChatMessage } from '@fortress-chat/shared';
import type { ResolvedTarget } from './target';

export class WatchdogError extends Error {}

export interface Usage { promptTokens: number; completionTokens: number }
export interface StreamResult { content: string; reasoning: string; usage: Usage | null }

export async function streamChat(
  target: ResolvedTarget, messages: ChatMessage[], onToken: (t: string) => void, signal: AbortSignal,
  onReasoning?: (t: string) => void,
): Promise<StreamResult> {
  const watchdogMs = Number(process.env.FC_WATCHDOG_MS ?? 60_000);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  let timer = setTimeout(() => ctrl.abort(new WatchdogError('no tokens for 60s')), watchdogMs);
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(new WatchdogError('no tokens for 60s')), watchdogMs); };
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...target.headers },
      body: JSON.stringify({ ...(target.model ? { model: target.model } : {}), messages, stream: true, stream_options: { include_usage: true }, ...target.bodyExtra }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Model server HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    let content = '';
    let reasoning = '';
    let usage: Usage | null = null;
    let buf = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = event.replace(/^data: /m, '').trim();
        if (!data || data === '[DONE]') continue;
        let j: any;
        try { j = JSON.parse(data); } catch { continue; }
        const d = j?.choices?.[0]?.delta ?? {};
        const c = d.content;
        if (typeof c === 'string' && c.length) { reset(); content += c; onToken(c); }
        const r = d.reasoning ?? d.reasoning_content;
        if (typeof r === 'string' && r.length) { reset(); reasoning += r; onReasoning?.(r); }
        if (j?.usage) usage = { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 };
      }
    }
    return { content, reasoning, usage };
  } catch (e) {
    if (ctrl.signal.reason instanceof WatchdogError) throw ctrl.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
