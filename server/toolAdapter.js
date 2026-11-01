'use strict';

// Client calls travel as data inside a native shell call. The gateway never
// executes the command: it decodes it back to the client's original tool API.
const CALL_PREFIX = 'opencode2api.tool:';

function protocolError(message, statusCode = 502) {
  return Object.assign(new Error(message), { code: 'tool_adapter_error', statusCode });
}

function parseArguments(value, statusCode = 400) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch { throw protocolError('Tool arguments must contain complete valid JSON.', statusCode); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw protocolError('Tool arguments must be a JSON object.', statusCode);
  }
  return parsed;
}

function encodeCall(call) {
  if (!call.function?.name) return call;
  const payload = { name: call.function.name, arguments: parseArguments(call.function.arguments) };
  return {
    ...call,
    function: {
      name: 'shell',
      arguments: JSON.stringify({ command: CALL_PREFIX + JSON.stringify(payload) })
    }
  };
}

function createToolAdapter(coreTools, definitions, choice, options = {}) {
  const clients = Array.isArray(definitions) ? definitions : [];
  const clientToolNames = new Set();
  for (const tool of clients) {
    if (tool.type !== 'function' || typeof tool.function?.name !== 'string') {
      throw protocolError('Only function tool definitions are supported by this endpoint.', 400);
    }
    if (clientToolNames.has(tool.function.name)) throw protocolError(`Duplicate client tool: ${tool.function.name}`, 400);
    clientToolNames.add(tool.function.name);
  }
  const forcedName = choice?.type === 'function' ? choice.function?.name : null;
  if (forcedName && !clientToolNames.has(forcedName)) throw protocolError('The selected tool is not declared by the client.', 400);
  const required = choice === 'required' || Boolean(forcedName);
  const disabled = !clients.length || choice === 'none';
  const toolChoice = disabled ? 'none' : required ? { type: 'function', function: { name: 'shell' } } : choice;

  function mapMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    const mapped = messages.map(message => {
      let next = message;
      if (Array.isArray(message.tool_calls)) next = { ...next, tool_calls: message.tool_calls.map(encodeCall) };
      if (message.function_call?.name) next = { ...next, function_call: encodeCall({ function: message.function_call }).function };
      if ((message.role === 'tool' || message.role === 'function') && message.name) next = { ...next, name: 'shell' };
      return next;
    });
    if (!clients.length) return mapped;
    const instruction = [
      '<opencode2api_client_tools>',
      'Client tool definitions are provided below in full. Their names, descriptions and JSON Schemas define the actual tools available to you.',
      'The five native tool definitions are a transport interface, not tools to execute directly.',
      'To call any client tool, invoke the native shell function. Set its command to the prefix ' + JSON.stringify(CALL_PREFIX) + ' followed by a JSON object with exactly these fields: name (the client tool name), arguments (its original JSON input).',
      'Example transport arguments: ' + JSON.stringify({ command: CALL_PREFIX + JSON.stringify({ name: clients[0].function.name, arguments: {} }) }),
      'Return only complete valid JSON. Preserve client argument names and values exactly. Do not add fields, wrap JSON in Markdown, or encode the arguments object as another JSON string.',
      'The gateway does not execute this command. It restores the original client tool call and routes it to the client. Do not use shell syntax or Markdown for the command.',
      'Do not call the native edit/glob/grep/read functions. A client tool with one of those names must also use the shell transport and its own original input schema.',
      'For parallel client calls, emit separate shell tool calls. Do not combine them in a command or a batch object.',
      'Tool call ids and tool results refer to the same client operations across turns. Follow the original conversation, instructions and tool semantics. Never discuss the transport in your answer.',
      forcedName ? `This turn MUST call only the client tool named ${JSON.stringify(forcedName)}.` : required ? 'This turn MUST call at least one client tool.' : disabled ? 'Tool calling is disabled for this turn. Answer without invoking tools.' : 'Use a client tool only when appropriate; otherwise answer normally.',
      options.parallelToolCalls === false ? 'Emit at most one client tool call in this turn.' : '',
      'Client tool catalog (unchanged JSON definitions):',
      JSON.stringify(clients),
      '</opencode2api_client_tools>'
    ].filter(Boolean).join('\n');
    const index = mapped.findIndex(message => message.role === 'system');
    if (index < 0) return [{ role: 'system', content: instruction }, ...mapped];
    const system = mapped[index];
    mapped[index] = {
      ...system,
      content: Array.isArray(system.content)
        ? [...system.content, { type: 'text', text: instruction }]
        : `${system.content || ''}\n\n${instruction}`
    };
    return mapped;
  }

  function restoreToolCalls(calls) {
    if (disabled && calls.length) throw protocolError('Upstream invoked a tool while tool calling was disabled.');
    const result = calls.map(call => {
      if (typeof call.id !== 'string' || !call.id) throw protocolError('Upstream client tool call is missing its id.');
      const wire = parseArguments(call.function?.arguments, 502);
      if (call.function?.name !== 'shell' || typeof wire?.command !== 'string' || !wire.command.startsWith(CALL_PREFIX)) {
        throw protocolError('Upstream did not return the declared client tool transport.');
      }
      const payload = parseArguments(wire.command.slice(CALL_PREFIX.length), 502);
      if (Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'name') || !Object.hasOwn(payload, 'arguments')) {
        throw protocolError('Client tool transport must contain exactly name and arguments.');
      }
      if (typeof payload.name !== 'string' || !clientToolNames.has(payload.name)) throw protocolError('Upstream requested an undeclared client tool.');
      if (forcedName && payload.name !== forcedName) throw protocolError('Upstream did not honor the client selected tool.');
      if (!payload.arguments || typeof payload.arguments !== 'object' || Array.isArray(payload.arguments)) {
        throw protocolError('Client tool arguments must be an object, not another encoded string.');
      }
      return {
        ...call,
        function: { name: payload.name, arguments: JSON.stringify(payload.arguments) }
      };
    });
    if (options.parallelToolCalls === false && result.length > 1) throw protocolError('Upstream did not honor parallel_tool_calls=false.');
    return result;
  }

  function createResponseMapper() {
    const choices = new Map();
    let metadata = {};
    function stateFor(index) {
      if (!choices.has(index)) choices.set(index, { calls: new Map(), finished: false });
      return choices.get(index);
    }
    function finish(state, delta, reason) {
      if (state.finished) return { delta, reason };
      state.finished = true;
      const rawCalls = [...state.calls.values()].map((call, index) => ({
        index,
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments }
      }));
      const restored = restoreToolCalls(rawCalls);
      if (required && !restored.length) throw protocolError('Upstream did not return the required client tool call.');
      const out = { ...delta };
      if (restored.length) out.tool_calls = restored;
      return { delta: out, reason: restored.length ? 'tool_calls' : reason === 'tool_calls' ? 'stop' : reason };
    }
    function push(chunk) {
      for (const key of ['id', 'object', 'created', 'model']) if (chunk[key] !== undefined) metadata[key] = chunk[key];
      if (chunk.error) throw protocolError(chunk.error.message || 'Upstream returned a stream error.');
      if (!Array.isArray(chunk.choices)) return chunk;
      const output = [];
      for (const [position, choice] of chunk.choices.entries()) {
        const state = stateFor(choice.index ?? position);
        let delta = { ...choice.delta };
        const calls = delta.tool_calls;
        delete delta.tool_calls;
        if (Array.isArray(calls)) {
          for (const part of calls) {
            const index = part.index ?? 0;
            if (!state.calls.has(index)) state.calls.set(index, { id: '', name: '', arguments: '' });
            const call = state.calls.get(index);
            if (typeof part.id === 'string') call.id += part.id;
            if (typeof part.function?.name === 'string') call.name += part.function.name;
            if (typeof part.function?.arguments === 'string') call.arguments += part.function.arguments;
          }
        }
        let reason = choice.finish_reason;
        if (reason !== undefined && reason !== null) {
          const finished = finish(state, delta, reason);
          delta = finished.delta;
          reason = finished.reason;
        }
        // Keep text/reasoning/usage; omit only intermediate transport fragments.
        if (!Object.keys(delta).length && reason == null && calls && !chunk.usage) continue;
        output.push({ ...choice, delta, ...(reason !== undefined ? { finish_reason: reason } : {}) });
      }
      if (!output.length && !chunk.usage) return null;
      return { ...chunk, choices: output };
    }
    function end() {
      if (required && !choices.size) throw protocolError('Upstream did not return the required client tool call.');
      const pending = [];
      for (const [index, state] of choices) {
        if (!state.finished && (state.calls.size || required)) {
          const result = finish(state, {}, 'stop');
          pending.push({ ...metadata, choices: [{ index, delta: result.delta, finish_reason: result.reason }] });
        }
      }
      return pending;
    }
    return { push, end };
  }

  return {
    tools: structuredClone(coreTools),
    toolChoice,
    clientToolNames,
    injectedToolNames: new Set(coreTools.map(tool => tool.function.name)),
    mapMessages,
    restoreToolCalls,
    createResponseMapper
  };
}

module.exports = { createToolAdapter, CALL_PREFIX, encodeCall };
