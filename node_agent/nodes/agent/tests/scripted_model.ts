// A rule-based stand-in for a model, for tests only — no network, no key, no randomness. Production
// has no such thing: the provider is a node on the bus (or whatever an embedder passes in).
//
// That is what lets an agent show the whole loop on a machine with no model configured. It is a
// provider like any other: it is handed the transcript and the tools, and streams the next line. It
// just decides by plain rules instead of guessing — reading each answer to pick the next call, and
// looking for a node whose schema can take the user's line, because that line is the only thing it
// has to offer.
import type { ChatReply, ChatRequest, Provider, StreamEvent, ToolCall } from '../src/types.ts';

/** The argument names the scripted model knows how to fill, best first. A shell takes a `command`,
 *  a memo takes a `title` — either way the user's line goes in as the value. It reads the schema to
 *  find them; it does not know any node or tool by name. */
const SINKS = ['command', 'title', 'text', 'query', 'msg'];

type Line = { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };

/** Wrap one call as the assistant line a model would have returned. */
function call(name: string, args: Record<string, unknown>): Line {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

function text(message: { content?: unknown } | undefined): string {
  return typeof message?.content === 'string' ? message.content : '';
}

/** The last thing the user said — what the scripted model hands to whichever tool it picks. */
function userLine(messages: readonly { role?: string; content?: unknown }[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return text(messages[index]);
  }
  return '';
}

/** The first "- name" line of a list_nodes answer. */
function firstNode(body: string): string | null {
  const found = /^- (.+)$/m.exec(body);
  return found === null ? null : (found[1] as string);
}

/** The name after `seen` in the most recent list_nodes answer — the next node to look at. A name
 *  that is no longer in that answer ends the walk instead of starting it over. */
function nextNode(messages: readonly { content?: unknown }[], seen: string): string | null {
  const listing = [...messages].reverse().find((message) => /^- /m.test(text(message)));
  const names = [...text(listing).matchAll(/^- (.+)$/gm)].map((match) => match[1] as string);
  const at = names.indexOf(seen);
  if (at < 0) return null;
  return at + 1 < names.length ? (names[at + 1] as string) : null;
}

/** The tools out of a list_node_tools answer: one block per tool, the `tool: description` line
 *  followed by an indented `parameters: {…}` line carrying that tool's schema. */
function toolsIn(body: string, node: string): { node: string; tool: string; schema: string }[] {
  const lines = body.split('\n');
  const found: { node: string; tool: string; schema: string }[] = [];
  for (const [index, line] of lines.entries()) {
    const head = /^(\S+?):/.exec(line ?? '');
    if (head === null) continue;
    found.push({
      node,
      tool: head[1] as string,
      schema: lines[index + 1] ?? '',
    });
  }
  return found;
}

/** The two things this model reads out of a JSON-Schema argument list. No `{` at all, or a body
 *  that is not a JSON object, makes it decline instead of guessing. */
function argNames(schema: string): { required: string[]; properties: string[] } | null {
  const at = schema.indexOf('{');
  const body = at < 0 ? '' : schema.slice(at);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const shape = raw as { required?: unknown; properties?: unknown };
  return {
    required: Array.isArray(shape.required)
      ? shape.required.filter((name): name is string => typeof name === 'string')
      : [],
    properties:
      typeof shape.properties === 'object' && shape.properties !== null
        ? Object.keys(shape.properties)
        : [],
  };
}

/** The one argument name this model can fill in the tool's schema, or null when it cannot. */
function sinkFor(schema: string): string | null {
  const names = argNames(schema);
  if (names === null) return null;
  // The model has exactly one value to offer, so a tool it can call must want nothing else —
  // `notes.update` also wants an `id`, and that is not something this model has.
  if (names.required.some((name) => !SINKS.includes(name))) return null;
  const offered = new Set([...names.required, ...names.properties]);
  return SINKS.find((sink) => offered.has(sink)) ?? null;
}

/** The next line, chosen by rule from what the transcript holds. */
export function scriptedLine(
  messages: readonly { role?: string; content?: unknown; tool_calls?: readonly ToolCall[] }[],
): Line {
  const last = messages.at(-1);
  if (last === undefined) return call('list_nodes', {});

  // The question is the assistant line just before the answer: a tool line carries the result,
  // never the call that asked for it.
  const asked = messages.at(-2)?.tool_calls?.[0]?.function.name;
  const body = text(last);

  // A result from run_on_node ends the turn; anything else means "ask the next question".
  if (asked === 'run_on_node') return { role: 'assistant', content: `done:\n${body}` };

  // list_nodes answers with one "- name" per line. No such line is not a list, so the scripted
  // model just says what it saw instead of guessing.
  if (asked === 'list_nodes') {
    const node = firstNode(body);
    if (node === null) return { role: 'assistant', content: body };
    return call('list_node_tools', { node });
  }

  // list_node_tools answers with every tool this node has, each with its schema. The first one that
  // takes something the model can supply wins; if none does, look at the next node.
  if (asked === 'list_node_tools') {
    const askedCall = messages.at(-2)?.tool_calls?.[0];
    const askedArgs = JSON.parse(askedCall?.function.arguments ?? '{}') as { node?: unknown };
    const node = typeof askedArgs.node === 'string' ? askedArgs.node : '';
    const found = toolsIn(body, node);
    for (const entry of found) {
      const sink = sinkFor(entry.schema);
      if (sink !== null) {
        return call('run_on_node', {
          node: entry.node,
          tool_name: entry.tool,
          tool_args: { [sink]: userLine(messages) },
        });
      }
    }
    const here = found[0]?.node ?? null;
    const following = here === null ? null : nextNode(messages, here);
    if (following === null) return { role: 'assistant', content: body };
    return call('list_node_tools', { node: following });
  }

  return call('list_nodes', {});
}

/** The scripted model as a provider: one line, emitted as the events a live provider would send. */
export class ScriptedProvider implements Provider {
  async chat(request: ChatRequest): Promise<ChatReply> {
    const line = scriptedLine(request.messages);
    return {
      content: line.content,
      ...(line.tool_calls !== undefined ? { tool_calls: line.tool_calls } : {}),
      previous_response_id: null,
    };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const line = scriptedLine(request.messages);
    if (line.content !== null && line.content !== '') {
      yield { type: 'content', text: line.content };
    }
    for (const [index, toolCall] of (line.tool_calls ?? []).entries()) {
      yield {
        type: 'tool_call',
        index,
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      };
    }
    yield { type: 'end', previous_response_id: null };
  }
}

export const scriptedModel = new ScriptedProvider();
