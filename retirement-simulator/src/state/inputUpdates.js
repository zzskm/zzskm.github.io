import { normalizeInput } from './migration.js';
// Metadata is handled separately from editable financial fields.
export function applyInputPatch(input, patch, { source = 'user' } = {}) {
  const values = Object.fromEntries(Object.entries(patch).filter(([key]) => key !== '_sources'));
  const sources = { ...input._sources };
  delete sources._sources;
  for (const key of Object.keys(values)) {
    if (source === 'default') delete sources[key];
    else sources[key] = source;
  }
  return normalizeInput({ ...input, ...values, _sources: sources });
}
