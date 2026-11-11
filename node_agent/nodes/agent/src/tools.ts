// The tools the model is handed: three about the bus, two about the cache of trimmed lines, and one
// that asks the reader. They travel in the request's own `tools` field — nothing about tools belongs
// in the prompt — and they are the same for every bus, because they are about the bus rather than
// about what happens to be on it.
import type { ToolSpec } from './types.js';

export const TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'list_nodes',
      description:
        'List the nodes on the bus. Call this first, then list_node_tools to see what one can do.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_node_tools',
      description:
        'List the capabilities one node offers: their names, descriptions and argument schemas.',
      parameters: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'node name, as list_nodes gave it' },
        },
        required: ['node'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_on_node',
      description:
        'Call one capability on one node; fill tool_args from the schema list_node_tools showed.',
      parameters: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'node name, as list_nodes gave it' },
          tool_name: {
            type: 'string',
            description: "the capability's local name on that node, e.g. exec",
          },
          tool_args: { type: 'object', description: 'the arguments to pass to that capability' },
        },
        required: ['node', 'tool_name', 'tool_args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_cache',
      description:
        'Read the cache of long inputs that were trimmed before they reached you. Without an entry it ' +
        "lists what is held, newest first, with each text's length and its head. With an entry it " +
        'returns that text, or the slice `start ... start+length` of it.',
      parameters: {
        type: 'object',
        properties: {
          entry: { type: 'integer', description: 'the entry number the warning named' },
          start: {
            type: 'integer',
            description: 'where in the text to start (optional, default 0)',
          },
          length: {
            type: 'integer',
            description: 'how many characters to return (optional, to the end)',
          },
        },
        required: ['entry'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_cache',
      description:
        "Search one cache entry for a regular expression. Returns each match's character position and " +
        'the matching text with up to `context` characters on each side.',
      parameters: {
        type: 'object',
        properties: {
          entry: { type: 'integer', description: 'the entry number the warning named' },
          pattern: { type: 'string', description: 'the regular expression to search for' },
          context: {
            type: 'integer',
            description: 'characters to include on each side (default 100)',
          },
        },
        required: ['entry', 'pattern'],
      },
    },
  },
];

/** The one tool whose result comes from a person. */
export const ASK_USER_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'ask_user',
    description:
      "Ask the user a question and wait for their answer, which comes back as this tool's result. Use " +
      'it when the choice is the user\u2019s to make and a guess would be worse than asking, e.g. which ' +
      'option, which file, whether to go on. Keep it short and answerable.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: "the card's one-line heading, e.g. which file should I edit",
        },
        content: {
          type: 'string',
          description: 'the question itself, in Markdown: the detail the answer needs (optional)',
        },
        selections: {
          type: 'array',
          items: { type: 'string' },
          description: 'the answers to offer as buttons; omit them and the user types one instead',
        },
        input: {
          type: 'string',
          enum: ['button', 'text'],
          description:
            'answer by picking one of the selections (button) or by typing (text); default: button when ' +
            'selections are given, text otherwise',
        },
        timeout_seconds: {
          type: 'number',
          description:
            'how long to wait for the reader, in seconds (default 300); 0 waits with no deadline',
        },
        default: {
          type: 'string',
          description:
            'the answer to carry on with when nobody answers in time: one of the selections or free ' +
            'text (optional). Omit it and a question that times out says only that nobody answered',
        },
      },
      required: ['title'],
    },
  },
};

/** The system line. It deliberately says nothing about which tools exist — their descriptions carry
 *  the order to call them in. */
export const SYSTEM = {
  role: 'system' as const,
  content:
    'You are the agent in this demo. When the machine has to be touched, call a tool, then answer the user.',
};

/** The pair a root agent uses to delegate: a sub-agent has its own transcript and round budget. */
export const SPAWN_TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'create_agent',
      description:
        'Start another agent on the bus under this name. It has its own transcript, its own round ' +
        'budget and the same tools; hand it a turn with run_on_node. Use it to keep a long or noisy ' +
        'side task out of this conversation. The drawing is required: a tab with no icon cannot be ' +
        'told from the others.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "the new agent's name: letters, digits, _ and -" },
          icon: {
            type: 'string',
            description:
              'required: the tab drawing, one <svg>...</svg> of SVG source (8192 bytes at most)',
          },
          provider: {
            type: 'string',
            description:
              "the provider row this agent should use; leave it out to inherit the parent's provider",
          },
        },
        required: ['name', 'icon'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'destroy_agent',
      description:
        'Stop an agent this one created and delete its transcript. Destroying is final: a later ' +
        'create_agent of the same name starts from nothing.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'the agent to stop' } },
        required: ['name'],
      },
    },
  },
];
