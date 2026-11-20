export const CURSOR_MODEL_CACHE_KEYS = [
  'model',
  'hasChangedDefaultModel',
  'maxMode',
  'modelParameters',
  'selectedModel',
  'modelSelectionHistory',
] as const;

/** Exact public presentation variant observed from the pinned Grok route. */
export const CURSOR_GROK_PRESENTATION_ALIAS = 'Grok 4.7  High Fast\u200B\u200B';

export type CursorFixedModelSelection = {
  model: 'grok-4.7-high-fast';
  context: '256k';
  reasoningEffort: 'high';
  fast: true;
  maxMode: false;
};

/** Pure semantic validation suitable for insertion into a guest with `.toString()`. */
export function cursorFixedModelSelection(config: unknown): CursorFixedModelSelection | null {
  const keys = ['model', 'hasChangedDefaultModel', 'maxMode', 'modelParameters', 'selectedModel', 'modelSelectionHistory'] as const;
  const base = 'grok-4.7';
  const full = 'grok-4.7-high-fast';

  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid /config object');
  const root = config as Record<string, unknown>;
  const present = keys.filter(key => Object.hasOwn(root, key));
  if (present.length === 0) return null;
  if (present.length !== keys.length) throw new Error('invalid /config/model-cache completeness');

  if (typeof root.hasChangedDefaultModel !== 'boolean') throw new Error('invalid /hasChangedDefaultModel boolean');
  if (root.maxMode !== false) throw new Error('invalid /maxMode false');

  if (!root.selectedModel || typeof root.selectedModel !== 'object' || Array.isArray(root.selectedModel)) throw new Error('invalid /selectedModel object');
  const selected = root.selectedModel as Record<string, unknown>;
  if (Object.keys(selected).some(key => !['modelId', 'parameters'].includes(key)) || !Object.hasOwn(selected, 'modelId') || !Object.hasOwn(selected, 'parameters')) throw new Error('invalid /selectedModel keys');
  if (selected.modelId !== base && selected.modelId !== full) throw new Error('invalid /selectedModel/modelId fixed-model');
  const selectedId = selected.modelId;

  if (!root.modelParameters || typeof root.modelParameters !== 'object' || Array.isArray(root.modelParameters)) throw new Error('invalid /modelParameters object');
  const parameterMap = root.modelParameters as Record<string, unknown>;
  const parameterKeys = Object.keys(parameterMap);
  if (parameterKeys.length < 1 || parameterKeys.length > 2 || parameterKeys.some(key => key !== base && key !== full) || !Object.hasOwn(parameterMap, selectedId)) throw new Error('invalid /modelParameters keys');
  const parameterChecks: Array<{ value: unknown; allowEmpty: boolean; label: string }> = [
    { value: selected.parameters, allowEmpty: false, label: 'invalid /selectedModel/parameters fixed-route' },
    ...parameterKeys.map(key => ({ value: parameterMap[key], allowEmpty: key === full, label: 'invalid /modelParameters/route fixed-route' })),
  ];
  for (const check of parameterChecks) {
    if (!Array.isArray(check.value)) throw new Error(check.label);
    if (check.allowEmpty && check.value.length === 0) continue;
    if (check.value.length !== 3) throw new Error(check.label);
    const expected: Record<string, string> = { context: '256k', reasoning_effort: 'high', fast: 'true' };
    const seen = new Set<string>();
    for (const entry of check.value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(check.label);
      const item = entry as Record<string, unknown>;
      if (Object.keys(item).some(key => key !== 'id' && key !== 'value') || !Object.hasOwn(item, 'id') || !Object.hasOwn(item, 'value')) throw new Error(check.label);
      if (typeof item.id !== 'string' || typeof item.value !== 'string' || !Object.hasOwn(expected, item.id) || expected[item.id] !== item.value || seen.has(item.id)) throw new Error(check.label);
      seen.add(item.id);
    }
    if (seen.size !== 3) throw new Error(check.label);
  }

  const history = root.modelSelectionHistory;
  if (!Array.isArray(history) || history.length < 1 || history.length > 32) throw new Error('invalid /modelSelectionHistory array');
  if (history.some(value => value !== base && value !== full)) throw new Error('invalid /modelSelectionHistory/modelId fixed-model');
  if (new Set(history).size !== history.length) throw new Error('invalid /modelSelectionHistory unique');

  if (!root.model || typeof root.model !== 'object' || Array.isArray(root.model)) throw new Error('invalid /model object');
  const model = root.model as Record<string, unknown>;
  const modelAllowed = ['modelId', 'displayModelId', 'displayName', 'displayNameShort', 'aliases', 'maxMode', 'thinkingDetails'];
  const modelRequired = ['modelId', 'displayModelId', 'displayName', 'displayNameShort', 'aliases'];
  if (Object.keys(model).some(key => !modelAllowed.includes(key)) || modelRequired.some(key => !Object.hasOwn(model, key))) throw new Error('invalid /model keys');
  if (model.modelId !== base && model.modelId !== full) throw new Error('invalid /model/modelId fixed-model');
  if (model.displayModelId !== base && model.displayModelId !== full) throw new Error('invalid /model/displayModelId fixed-model');
  // Keep this literal self-contained because the validator is inserted into the
  // isolated guest with Function#toString. It must match the exported alias.
  const displayNames = ['Grok 4.7 256K High Fast', 'Grok 4.7', 'Grok 4.7  High Fast\u200B\u200B'];
  if (typeof model.displayName !== 'string' || !displayNames.includes(model.displayName)) throw new Error('invalid /model/displayName presentation');
  if (typeof model.displayNameShort !== 'string' || !displayNames.includes(model.displayNameShort)) throw new Error('invalid /model/displayNameShort presentation');
  if (!Array.isArray(model.aliases) || model.aliases.length > 2 || model.aliases.some(alias => alias !== base && alias !== full) || new Set(model.aliases).size !== model.aliases.length) throw new Error('invalid /model/aliases presentation');
  if (Object.hasOwn(model, 'maxMode') && model.maxMode !== false) throw new Error('invalid /model/maxMode false');
  if (Object.hasOwn(model, 'thinkingDetails')) {
    if (!model.thinkingDetails || typeof model.thinkingDetails !== 'object' || Array.isArray(model.thinkingDetails)) throw new Error('invalid /model/thinkingDetails object');
    if (Object.keys(model.thinkingDetails).length !== 0) throw new Error('invalid /model/thinkingDetails empty');
  }

  return { model: full, context: '256k', reasoningEffort: 'high', fast: true, maxMode: false };
}
