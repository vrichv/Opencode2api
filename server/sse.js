'use strict';

const { StringDecoder } = require('string_decoder');

/**
 * Incrementally parse SSE data events. onData receives the joined data string,
 * including the literal "[DONE]" marker; JSON parsing belongs to the caller.
 * end() also dispatches a final event without a trailing blank line.
 */
function createSseParser(onData) {
  if (typeof onData !== 'function') {
    throw new TypeError('onData must be a function');
  }

  const decoder = new StringDecoder('utf8');
  let line = '';
  let dataLines = [];
  let skipLf = false;
  let firstCharacter = true;
  let ended = false;

  function dispatch() {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    dataLines = [];
    onData(data);
  }

  function consumeLine() {
    const complete = line;
    line = '';
    if (complete === '') {
      dispatch();
      return;
    }
    if (complete.startsWith(':')) return;

    const colon = complete.indexOf(':');
    const field = colon < 0 ? complete : complete.slice(0, colon);
    if (field !== 'data') return;
    let value = colon < 0 ? '' : complete.slice(colon + 1);
    // SSE removes one optional ASCII space, not all leading whitespace.
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  }

  function consume(text) {
    if (!text) return;
    if (firstCharacter) {
      firstCharacter = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }

    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (skipLf) {
        skipLf = false;
        if (code === 10) {
          start = index + 1;
          continue;
        }
      }
      if (code !== 10 && code !== 13) continue;
      line += text.slice(start, index);
      start = index + 1;
      skipLf = code === 13;
      consumeLine();
    }
    line += text.slice(start);
  }

  return {
    write(chunk) {
      if (ended) throw new Error('Cannot write after SSE parser end');
      if (typeof chunk === 'string') {
        consume(decoder.write(Buffer.from(chunk, 'utf8')));
      } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
        consume(decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
      } else {
        throw new TypeError('SSE chunk must be a string, Buffer, or Uint8Array');
      }
    },
    end() {
      if (ended) return;
      ended = true;
      consume(decoder.end());
      if (line !== '') consumeLine();
      dispatch();
    }
  };
}

module.exports = { createSseParser };
