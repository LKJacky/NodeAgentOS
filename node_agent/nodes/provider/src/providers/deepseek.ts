// The DeepSeek row: the chat-completions wire with DeepSeek's own house rules on top.
//
// It is the same protocol as an OpenAI-compatible endpoint, so everything below the few differences
// is inherited rather than copied: the endpoint it points at when a row leaves the address blank,
// the way it arms thinking mode, and the one field its thinking mode insists on. Everything DeepSeek-specific lives here, so the generic
// provider stays generic and a bug like "reasoning_content must be passed back" can be fixed
// without teaching every endpoint about one vendor.
import {
  type Fetcher,
  type JsonObject,
  type Message,
  type ToolSpec,
  OpenAIProvider,
  optionalString,
  thinkingEffort,
  timeoutOf,
} from './base.js';

/** Where DeepSeek's OpenAI-compatible API lives: what comes before `/chat/completions`. */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** DeepSeek's own effort ladder. The other presets the form offers map onto it: a row that says
 *  `minimal` is asking for the least thinking DeepSeek has, not for a value it would refuse. */
export function deepSeekEffort(effort: string | null): 'low' | 'high' | 'max' | null {
  if (effort === null) return null;
  const wanted = effort.trim().toLowerCase();
  if (wanted === '' || wanted === 'none' || wanted === 'disabled') return null;
  if (wanted === 'minimal' || wanted === 'low') return 'low';
  if (wanted === 'xhigh' || wanted === 'max') return 'max';
  return 'high';
}

export class DeepSeekProvider extends OpenAIProvider {
  static build(data: JsonObject, fetcher: Fetcher): DeepSeekProvider {
    return new DeepSeekProvider({
      apiKey: optionalString(data, 'api_key'),
      organization: optionalString(data, 'organization'),
      modelName: optionalString(data, 'model_name') ?? '',
      // A DeepSeek row that names no address means DeepSeek's, not OpenAI's.
      baseUrl: optionalString(data, 'base_url') ?? DEEPSEEK_BASE_URL,
      timeout: timeoutOf(data, 'DeepSeek'),
      effort: thinkingEffort(data),
      fetcher,
    });
  }

  override dump(): JsonObject {
    return { ...super.dump(), type: 'deepseek' };
  }

  /** Arming thinking is DeepSeek's own switch: the documented pair is `thinking` plus an effort from
   *  its ladder. A row with no effort says nothing and leaves the endpoint's default alone. */
  protected override body(
    messages: Message[],
    tools?: ToolSpec[] | null,
    limit?: number | null,
  ): JsonObject {
    const body = super.body(messages, tools, limit);
    const effort = deepSeekEffort(this.effort);
    if (effort === null && this.effort !== null) {
      // `none` means off: the switch says it, and the generic field would name a level DeepSeek
      // does not have.
      body.thinking = { type: 'disabled' };
      delete body.reasoning_effort;
    }
    if (effort !== null) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = effort;
    }
    return body;
  }

  /** A tool-call line must carry `reasoning_content` — even when the model answered without thinking
   *  and the transcript never wrote one. DeepSeek reads the missing key as a dropped chain of thought
   *  and refuses the next request with `The reasoning_content in the thinking mode must be passed
   *  back to the API`; an empty string is accepted (verified against the live endpoint). */
  protected override wireMessage(message: Message): JsonObject {
    const row = super.wireMessage(message);
    const calls = row.tool_calls;
    if (
      Array.isArray(calls) &&
      calls.length > 0 &&
      (row.reasoning_content === undefined || row.reasoning_content === null)
    ) {
      row.reasoning_content = '';
    }
    return row;
  }
}
