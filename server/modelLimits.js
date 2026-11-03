'use strict';

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// Keep model metadata and actual request caps in agreement. These are total
// context/output limits, not an estimate of the client's prompt occupancy.
function modelLimits(model = {}) {
  const context = positiveInteger(model.context_window) || 200000;
  const output = Math.min(positiveInteger(model.max_output) || 32000, context);
  const input = Math.min(positiveInteger(model.max_input) || context, context);
  return { context, input, output };
}

function publicLimits(model) {
  const limit = modelLimits(model);
  return {
    context_window: limit.context,
    max_output: limit.output,
    // DSH/pi model discovery recognizes these names, but not max_output alone.
    max_output_tokens: limit.output,
    limit
  };
}

module.exports = { positiveInteger, modelLimits, publicLimits };
